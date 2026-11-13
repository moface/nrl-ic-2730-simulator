"""Load the instance configuration without third-party dependencies."""
import ipaddress
import tomllib
from urllib.parse import urlsplit

from .nrl_endpoint import Identity


def load_config(path):
    with path.open('rb') as source:
        return tomllib.load(source)


def origin_url(value):
    parsed = urlsplit(value)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or
            parsed.path not in ('', '/') or parsed.query or parsed.fragment):
        raise ValueError('public_origin 必须是 HTTPS 源地址')
    port = parsed.port
    return f'https://{parsed.hostname.lower()}' + (f':{port}' if port and port != 443 else '')


def setup(config, directory):
    web = config.get('web', {})
    nrl = config.get('nrl', {})
    bind = web.get('bind', '127.0.0.1')
    port = web.get('port', 8787)
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError('网页端口必须为 1–65535')
    origin = origin_url(web['public_origin']) if web.get('public_origin') else None
    proxies = {ipaddress.ip_address(ip) for ip in web.get('trusted_proxies', [])}
    hosts = set(web.get('allowed_hosts', []))
    auth = config.get('auth', {})
    password = (directory / auth['password_file']).read_text().rstrip('\r\n') if auth.get('password_file') else auth.get('password', '')
    if origin and len(password) < 8:
        raise ValueError('HTTPS 远程模式需要至少 8 位的网页密码')
    if bind not in ('127.0.0.1', 'localhost') and not origin and not hosts:
        raise ValueError('远程监听需要配置 public_origin 或 allowed_hosts')
    if origin and not proxies and not (web.get('tls_cert') and web.get('tls_key')):
        raise ValueError('HTTPS 需要配置可信反代地址或 TLS 证书与私钥')
    identity = None
    if nrl.get('enabled', False):
        password_file = nrl.get('password_file')
        device_password = (directory / password_file).read_bytes().rstrip(b'\r\n') if password_file else nrl.get('password', '').encode('ascii')
        if not nrl.get('host') or type(nrl.get('port', 60050)) is not int or not 1 <= nrl.get('port', 60050) <= 65535:
            raise ValueError('请配置 NRL 服务器地址和有效 UDP 端口')
        if type(nrl.get('client_ssid')) is not int:
            raise ValueError('软机头 SSID 必须为整数')
        identity = Identity(nrl['callsign'].upper(), nrl['client_ssid'], password=device_password)
        host_ssid = nrl['host_ssid']
        panels = nrl.get('hardware_panel_ssids', [])
        if any(type(ssid) is not int or not 0 <= ssid <= 255 for ssid in [host_ssid, *panels]):
            raise ValueError('SSID 范围为 0–255')
        if identity.ssid in [host_ssid, *panels] or host_ssid in panels:
            raise ValueError('软机头、机身和硬机头的 SSID 必须区分')
    limit = nrl.get('tx_limit_seconds', 60)
    idle = nrl.get('offline_idle_seconds', 300)
    if type(limit) is not int or not 1 <= limit <= 600 or type(idle) is not int or idle < 1:
        raise ValueError('发射时限须为 1–600 秒，自动脱网时限须为正整数')
    return web, nrl, bind, port, origin, proxies, hosts, auth.get('username', 'softhead'), password, identity
