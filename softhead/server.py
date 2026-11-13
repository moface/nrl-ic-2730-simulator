"""Soft head with loopback preview or authenticated HTTPS access."""
import argparse
import hmac
from html import escape
from http.cookies import CookieError, SimpleCookie
from ipaddress import ip_address
import signal
import json
from queue import Empty
import re
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import secrets
import ssl
import threading
from time import monotonic, sleep, time
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

from .config import load_config, setup
from .live_head import LiveHead, PANEL_LEVELS, empty_snapshot, validate_startup_levels

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / 'web'
STREAM_LOCK = threading.Lock()
SESSION_COOKIE = 'softhead_session'
SESSION_SECONDS = 12 * 60 * 60


def hardware_panel_warning(url, callsign, ssids):
    if not url and ssids:
        return '无法查询硬机头状态，请先确认硬机头是否已脱网。'
    online = []
    uncertain = False
    for ssid in ssids:
        body = json.dumps({'callsign': callsign, 'ssid': ssid}).encode()
        request = Request(url, data=body,
                          headers={'Content-Type': 'application/json'})
        try:
            with urlopen(request, timeout=1) as response:
                result = json.load(response)
            if result.get('code') == 20001 and result.get('message') == '操作失败':
                continue  # This SSID is not registered on the server.
            device = result.get('data')
            if (result.get('code') != 20000 or not isinstance(device, dict) or
                    device.get('callsign') != callsign or device.get('ssid') != ssid or
                    type(device.get('is_online')) is not bool):
                uncertain = True
                continue
            if device['is_online'] and device.get('dev_model') == 14:
                online.append(f'{callsign}-{ssid}')
        except (OSError, ValueError, AttributeError):
            uncertain = True
    if online:
        return f"硬机头 {'、'.join(online)} 在线。同时联网可能使硬机头卡顿。"
    if uncertain:
        return '暂时无法确认硬机头是否在线。同时联网可能使硬机头卡顿。'
    return None


class LiveSession:
    def __init__(self, address, allow_tx, identity, host_ssid, tx_limit, idle_seconds):
        self.address = address
        self.allow_tx = allow_tx
        self.identity = identity
        self.host_ssid = host_ssid
        self.tx_limit = tx_limit
        self.idle_seconds = idle_seconds
        self.lock = threading.Lock()
        self.head = None
        self.last_activity = monotonic()
        self.off_since = None
        self.offline_reason = None
        self.disconnecting = False

    @property
    def active(self):
        head = self.head
        return head if head is not None and not head.stop_event.is_set() else None

    @property
    def snapshot(self):
        head = self.active
        return {
            **(head.snapshot if head else empty_snapshot()),
            'network_enabled': head is not None,
            'station': f'{self.identity.callsign}-{self.identity.ssid}',
            'offline_idle_seconds': self.idle_seconds,
            'offline_reason': None if head else self.offline_reason,
        }

    def close_head(self, reason):
        if self.head is not None and not self.head.close():
            return '软机头正在释放连接，请稍后重试'
        self.head = None
        self.off_since = None
        self.offline_reason = reason
        return None

    def set_network(self, enabled):
        with self.lock:
            if self.disconnecting:
                return '正在关机并脱网，请稍候'
            if not enabled:
                return self.close_head('manual')
            if self.head is not None and self.active is None:
                error = self.close_head('manual')
                if error:
                    return error
            if self.head is None:
                self.head = LiveHead(self.address, self.allow_tx, identity=self.identity,
                                     host_ssid=self.host_ssid, tx_limit=self.tx_limit)
            self.last_activity = monotonic()
        return None

    def disconnect_after_power_off(self, shutdown):
        with self.lock:
            head = self.active
            if self.disconnecting:
                return '正在关机并脱网，请稍候'
            if head is None:
                return self.close_head('manual')
            self.disconnecting = True
            self.last_activity = monotonic()

        try:
            state = head.snapshot
            deadline = monotonic() + 3
            while self.radio_busy(state) and monotonic() < deadline:
                sleep(.05)
                state = head.snapshot
            if self.radio_busy(state):
                return '机身正在操作或发射，请稍后再脱网'
            if not state['online'] or state['power'] == 'unknown':
                return '机身电源状态未同步，软机头保持联网'
            if state['power'] == 'on':
                if not shutdown:
                    return '机身仍开着，请确认关机后再脱网'
                error = head.request('power', 'off')
                if error:
                    return error
                deadline = monotonic() + 11
                while monotonic() < deadline:
                    state = head.snapshot
                    if state['online'] and state['power'] == 'off' and not self.radio_busy(state):
                        break
                    sleep(.05)
                else:
                    return '未收到机身关机回显，软机头保持联网'
            with self.lock:
                return self.close_head('manual')
        finally:
            with self.lock:
                self.disconnecting = False

    @staticmethod
    def radio_busy(state):
        return state['busy'] or state['tx'] or state['tx_releasing'] or any(
            'TX' in labels for labels in state['flags'])

    def expire_idle(self):
        with self.lock:
            head = self.active
            if head is None or self.disconnecting:
                return
            state = head.snapshot
            if state['busy'] or state['tx'] or state['tx_releasing'] or state['power'] == 'on':
                self.off_since = None
                return
            now = monotonic()
            if state['power'] == 'off':
                if self.off_since is None:
                    self.off_since = now
            elif state['lcd'] != [' ' * 10] * 2:
                # A blank display may go quiet after confirmed shutdown. A new display resets it.
                self.off_since = None
            if self.off_since is not None and now - max(self.off_since, self.last_activity) >= self.idle_seconds:
                self.close_head('power-off-idle')

    def request(self, action, value):
        with self.lock:
            head = self.active
            if self.disconnecting and action not in ('tx-stop', 'activity'):
                return '正在关机并脱网，请稍候'
            if head is not None and action not in ('tx-audio', 'tx-stop'):
                self.last_activity = monotonic()
        if action == 'activity':
            return None
        return head.request(action, value) if head else '软机头已脱网'


class PreviewServer(ThreadingHTTPServer):
    tls = None
    authorization = None

    def service_actions(self):
        if self.live is not None:
            self.live.expire_idle()

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(6)
        if self.tls is not None:
            try:
                connection = self.tls.wrap_socket(connection, server_side=True,
                                                  do_handshake_on_connect=False)
            except Exception:
                connection.close()
                raise
        return connection, address


class PreviewHandler(SimpleHTTPRequestHandler):
    def log_request(self, code='-', size='-'):
        if (self.route != '/live/state' and not getattr(self, 'activity_request', False)) or code != 200:
            super().log_request(code, size)

    @property
    def proxied(self):
        return (self.server.public_origin is not None and
                ip_address(self.client_address[0]) in self.server.trusted_proxies and
                self.headers.get('Host', '').lower() == urlsplit(self.server.public_origin).netloc.lower())

    @property
    def origin(self):
        if self.proxied or self.server.tls:
            return self.server.public_origin
        return 'http://' + self.headers.get('Host', '')

    @property
    def route(self):
        path = urlsplit(self.path).path
        if path.startswith('/softhead/debug/'):
            return path.removeprefix('/softhead/debug')
        if path.startswith('/softhead/'):
            return '/mock' + path.removeprefix('/softhead')
        return path

    def login_destination(self):
        url = urlsplit(self.path)
        if self.route in ('/mock/', '/mock/index.html'):
            query = parse_qs(url.query)
            if query.get('mode') == ['live']:
                return '/softhead/?mode=live'
            if query.get('protocol') == ['1']:
                return '/softhead/?protocol=1'
            return '/softhead/'
        if self.route in ('/', '/index.html', '/live.html'):
            return '/softhead/debug/'
        return None

    def login_page(self, error=''):
        body = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>登录软机头</title>
<style>
*{{box-sizing:border-box}}body{{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#191c1b;color:#edf1e9;font:16px system-ui,sans-serif}}
main{{width:min(100%,360px);padding:28px;border:1px solid #414941;border-radius:12px;background:#232824}}h1{{font-size:22px;margin:0 0 22px}}
form,label{{display:grid;gap:8px}}form{{gap:16px}}input,button{{font:inherit;border:1px solid #626d5d;border-radius:6px;padding:10px}}
input{{width:100%;color:inherit;background:#171b18}}button{{margin-top:4px;background:#cfdfa8;color:#20271c;cursor:pointer}}p{{margin:0 0 14px;color:#ffd3b0}}
</style></head><body><main><h1>登录软机头</h1>
{f'<p role="alert">{escape(error)}</p>' if error else ''}
<form method="post"><label>用户名<input name="username" autocomplete="username" required></label>
<label>密码<input type="password" name="password" autocomplete="current-password" required></label>
<button type="submit">登录</button></form></main></body></html>""".encode()
        self.send_response(401 if error else 200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    @staticmethod
    def session_signature(key, payload):
        return hmac.digest(key, b'softhead-session-v1:' + payload.encode(), 'sha256').hex()

    def session_expiry(self, key):
        try:
            cookies = SimpleCookie(self.headers.get('Cookie', ''))
        except CookieError:
            return None
        if SESSION_COOKIE not in cookies:
            return None
        token = cookies[SESSION_COOKIE].value
        if not re.fullmatch(r'\d{1,12}\.[0-9a-f]{32}\.[0-9a-f]{64}', token):
            return None
        payload, signature = token.rsplit('.', 1)
        expiry = int(payload.split('.', 1)[0])
        valid = hmac.compare_digest(signature, self.session_signature(key, payload))
        return expiry if valid and expiry > time() else None

    def sign_in(self, expected, destination):
        if self.headers.get('Origin') != self.origin:
            self.send_error(403)
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 1 <= size <= 1800 or self.headers.get_content_type() != 'application/x-www-form-urlencoded':
                raise ValueError
            self.connection.settimeout(2)
            data = parse_qs(self.rfile.read(size).decode('ascii'), max_num_fields=2, strict_parsing=True)
            if set(data) != {'username', 'password'} or any(len(values) != 1 for values in data.values()):
                raise ValueError
            username, password = data['username'][0], data['password'][0]
        except (ValueError, TimeoutError):
            self.login_page('请输入用户名和密码。')
            return
        supplied = password.encode()
        if username != self.server.username or not hmac.compare_digest(expected, supplied):
            self.login_page('用户名或密码不正确。')
            return
        payload = f'{int(time()) + SESSION_SECONDS}.{secrets.token_hex(16)}'
        signature = self.session_signature(expected, payload)
        scope = '/softhead/'
        self.send_response(303)
        self.send_header('Location', destination)
        self.send_header('Set-Cookie', f'{SESSION_COOKIE}={payload}.{signature}; Path={scope}; '
                                      f'Max-Age={SESSION_SECONDS}; Secure; HttpOnly; SameSite=Lax')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def authorized(self):
        host = self.headers.get('Host', '').lower()
        secure = bool(self.proxied or self.server.tls)
        if secure:
            if host != urlsplit(self.origin).netloc.lower():
                self.send_error(403)
                return False
        elif (host not in self.server.allowed_hosts and
              (host not in self.server.loopback_hosts or not ip_address(self.client_address[0]).is_loopback)):
            self.send_error(403)
            return False
        expected = self.server.authorization if secure else None
        if expected is None:
            return True
        destination = self.login_destination()
        if self.command == 'POST' and destination:
            self.sign_in(expected, destination)
            return False
        self.auth_expiry = self.session_expiry(expected)
        if self.auth_expiry is not None:
            return True
        if destination and self.command in ('GET', 'HEAD'):
            self.login_page()
        else:
            self.send_response(401)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', '0')
            self.end_headers()
        return False

    def trusted(self):
        return (self.headers.get('X-Softhead-Audio') == '1' and
                self.headers.get('Sec-Fetch-Site') in (None, 'same-origin'))

    def json_reply(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if not self.authorized():
            return
        if not self.trusted() or self.headers.get('Origin') != self.origin:
            self.send_error(403)
            return
        if self.route != '/live/action' or self.server.live is None:
            self.send_error(404)
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 1 <= size <= 1800:
                raise ValueError
            self.connection.settimeout(2)
            body = json.loads(self.rfile.read(size))
            action, value = body['action'], body['value']
            if action in ('tx-start', 'tx-stop', 'tx-audio'):
                if not isinstance(value, str) or not re.fullmatch('[a-f0-9]{32}', value):
                    raise ValueError
                if action == 'tx-audio':
                    data = body['audio']
                    if not isinstance(data, str) or not re.fullmatch(r'(?:[a-f0-9]{200}){1,6}', data):
                        raise ValueError
                    value = (value, [bytes.fromhex(data[i:i+200]) for i in range(0, len(data), 200)])
            elif action == 'power-on-levels':
                validate_startup_levels(value)
            elif action == 'activity':
                if value != 'web':
                    raise ValueError
                self.activity_request = True
            elif action == 'network':
                if value not in ('on', 'off', 'force-on', 'off-if-powered-off', 'shutdown-and-off'):
                    raise ValueError
            elif isinstance(action, str) and action in PANEL_LEVELS:
                if type(value) is not int or not 1 <= value <= PANEL_LEVELS[action][1]:
                    raise ValueError
            elif action not in ('key', 'key-hold', 'dial', 'step', 'volume', 'mic', 'power') or not isinstance(value, str):
                raise ValueError
        except (ValueError, KeyError, TypeError, TimeoutError):
            self.json_reply({'error': '无效操作'}, 400)
            return
        if action == 'power' and value == 'recover-off' and not ip_address(self.client_address[0]).is_loopback:
            self.send_error(403)
            return
        if action.startswith('tx-') and not (self.proxied or self.server.tls or
                ip_address(self.client_address[0]).is_loopback and urlsplit(self.origin).hostname in ('localhost', '127.0.0.1')):
            self.send_error(403)
            return
        if action == 'network':
            if value == 'on' and self.server.live.active is None:
                warning = hardware_panel_warning(self.server.device_status_url, self.server.live.identity.callsign,
                                                 self.server.hardware_panel_ssids)
                if warning:
                    self.json_reply({'error': warning, 'confirm_network': True}, 409)
                    return
            if value in ('off-if-powered-off', 'shutdown-and-off'):
                error = self.server.live.disconnect_after_power_off(shutdown=value == 'shutdown-and-off')
            else:
                error = self.server.live.set_network(value != 'off')
        else:
            error = self.server.live.request(action, value)
        self.json_reply({'error': error}, 409 if error else 200)

    def redirect_panel(self):
        path = urlsplit(self.path).path
        if path not in ('/', '/softhead', '/softhead/debug'):
            return False
        destination = {'/': '/softhead/', '/softhead': '/softhead/', '/softhead/debug': '/softhead/debug/'}[path]
        if path == '/' and self.proxied:
            return False  # Existing NAS proxy maps /softhead/debug/ to /.
        self.send_response(308)
        self.send_header('Location', destination)
        self.send_header('Content-Length', '0')
        self.end_headers()
        return True

    def end_headers(self):
        if getattr(self, 'serving_static', False):
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def static_page(self, route):
        filename = route.removeprefix('/mock/').lstrip('/')
        if not filename or filename == 'index.html':
            filename = 'index.html' if route.startswith('/mock/') else 'live.html'
        if '/' in filename or filename not in self.server.web_files:
            self.send_error(404)
            return
        self.path = '/' + filename
        self.serving_static = True
        if self.command == 'HEAD':
            super().do_HEAD()
        else:
            super().do_GET()

    def do_HEAD(self):
        if not self.redirect_panel() and self.authorized():
            self.static_page(self.route)

    def do_GET(self):
        if self.redirect_panel() or not self.authorized():
            return
        route = self.route
        if route == '/live/state':
            if not self.trusted():
                self.send_error(403)
                return
            if self.server.live is None:
                self.json_reply({**empty_snapshot(), 'network_enabled': False, 'live_available': False})
                return
            snapshot = self.server.live.snapshot
            if not (self.proxied or self.server.tls or
                    ip_address(self.client_address[0]).is_loopback and urlsplit(self.origin).hostname in ('localhost', '127.0.0.1')):
                snapshot['tx_enabled'] = False
            self.json_reply(snapshot)
            return
        if route != '/audio':
            self.static_page(route)
            return
        if not self.trusted():
            self.send_error(403)
            return
        head = self.server.live.active if self.server.live else None
        if head is None:
            self.send_error(503, 'Soft head offline')
            return
        if not STREAM_LOCK.acquire(blocking=False):
            self.send_error(409, 'Audio monitor already open')
            return
        try:
            self.stream_live_audio(head)
        except OSError:
            pass
        finally:
            STREAM_LOCK.release()

    def session_alive(self):
        expiry = getattr(self, 'auth_expiry', None)
        return expiry is None or expiry > time()

    def stream_live_audio(self, head):
        self.connection.settimeout(3)
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        queue = head.audio
        while not head.stop_event.is_set() and self.session_alive():
            try:
                frame = queue.get(timeout=.5)
                self.wfile.write(b'\x01' + frame)
            except Empty:
                self.wfile.write(b'\x00')
            except OSError:
                return


def main():
    parser = argparse.ArgumentParser(description='IC-2730 browser panel and NRL bridge')
    parser.add_argument('--config', type=Path, default=Path('config.toml'))
    args = parser.parse_args()
    try:
        config = load_config(args.config) if args.config.exists() or args.config != Path('config.toml') else {}
        web, nrl, bind, port, origin, proxies, hosts, username, password, identity = setup(config, args.config.parent)
        tls = None
        if origin and not proxies:
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.minimum_version = ssl.TLSVersion.TLSv1_2
            tls.load_cert_chain(args.config.parent / web['tls_cert'], args.config.parent / web['tls_key'])
    except (OSError, KeyError, ValueError, TypeError) as error:
        parser.error(str(error))

    def terminate(*_):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, terminate)
    handler = partial(PreviewHandler, directory=str(DIST))
    with PreviewServer((bind, port), handler) as server:
        server.tls = tls
        server.authorization = password.encode() if origin else None
        server.username = username
        server.public_origin = origin
        server.trusted_proxies = proxies
        server.loopback_hosts = {f'127.0.0.1:{server.server_port}', f'localhost:{server.server_port}'}
        server.allowed_hosts = {host.lower() for host in hosts}
        server.web_files = {path.name for path in DIST.iterdir() if path.is_file()}
        server.device_status_url = nrl.get('device_status_url')
        server.hardware_panel_ssids = nrl.get('hardware_panel_ssids', [])
        server.live = LiveSession((nrl['host'], nrl.get('port', 60050)), nrl.get('allow_tx', False),
                                  identity, nrl['host_ssid'], nrl.get('tx_limit_seconds', 60),
                                  nrl.get('offline_idle_seconds', 300)) if identity else None
        print(f'软机头网页 {origin or f"http://127.0.0.1:{server.server_port}"}/softhead/', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            if server.live is not None:
                server.live.set_network(False)


if __name__ == '__main__':
    main()
