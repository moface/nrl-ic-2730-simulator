import http.client
from pathlib import Path
from threading import Thread
import unittest
from functools import partial
from urllib.parse import urlencode

from softhead.config import setup
from softhead.server import DIST, PreviewHandler, PreviewServer


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.server = PreviewServer(('127.0.0.1', 0), partial(PreviewHandler, directory=str(DIST)))
        self.server.public_origin = 'https://radio.example.org'
        self.server.trusted_proxies = setup({'web': {'trusted_proxies': ['127.0.0.1']}}, Path('.'))[5]
        self.server.authorization = b'test-only-password'
        self.server.username = 'operator'
        self.server.live = None
        self.server.web_files = {path.name for path in DIST.iterdir() if path.is_file()}
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, path, *, cookie=None, login=None):
        headers = {'Host': 'radio.example.org', 'X-Softhead-Audio': '1'}
        method = 'GET'
        data = None
        if login is not None:
            method = 'POST'
            data = urlencode({'username': 'operator', 'password': login})
            headers.update(Origin='https://radio.example.org', **{'Content-Type': 'application/x-www-form-urlencoded'})
        if cookie:
            headers['Cookie'] = cookie
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        try:
            connection.request(method, path, data, headers)
            response = connection.getresponse()
            return response.status, response.headers, response.read()
        finally:
            connection.close()

    def test_form_login_and_shared_session(self):
        status, headers, body = self.request('/softhead/?mode=live')
        self.assertEqual(status, 200)
        self.assertIn(b'autocomplete="current-password"', body)
        self.assertNotIn('WWW-Authenticate', headers)
        self.assertEqual(self.request('/softhead/debug/live/state')[0], 401)
        self.assertEqual(self.request('/softhead/?mode=live', login='wrong')[0], 401)
        status, headers, _ = self.request('/softhead/?mode=live', login='test-only-password')
        self.assertEqual(status, 303)
        self.assertEqual(headers['Location'], '/softhead/?mode=live')
        self.assertIn('Secure; HttpOnly; SameSite=Lax', headers['Set-Cookie'])
        cookie = headers['Set-Cookie'].split(';', 1)[0]
        self.assertEqual(self.request('/softhead/debug/live/state', cookie=cookie)[0], 200)
        self.assertIn(b'IC-2730E', self.request('/softhead/', cookie=cookie)[2])
        self.assertEqual(self.request('/softhead/debug/panel-live.mjs', cookie=cookie)[0], 200)
        self.assertEqual(self.request('/softhead/debug/live/state', cookie=cookie + '0')[0], 401)

    def test_configurable_distinct_device_identity(self):
        options = {'enabled': True, 'host': 'nrl.example.org', 'callsign': 'N0CALL',
                   'client_ssid': 19, 'host_ssid': 5, 'hardware_panel_ssids': [6]}
        identity = setup({'nrl': options}, Path('.'))[-1]
        self.assertEqual((identity.callsign, identity.ssid), ('N0CALL', 19))
        with self.assertRaises(ValueError):
            setup({'nrl': {**options, 'client_ssid': 5}}, Path('.'))
