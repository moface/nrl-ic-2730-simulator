import socket
import unittest

from softhead.nrl_endpoint import Identity, NrlEndpoint
from softhead.protocol import decode_packet


class EndpointTests(unittest.TestCase):
    def test_heartbeat_and_bidirectional_udp(self):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as server:
            server.bind(('127.0.0.1', 0))
            server.settimeout(1)
            identity = Identity('N0TEST', 101, password=b'test')
            host = Identity('N0TEST', 0)
            with NrlEndpoint(server.getsockname(), identity) as client:
                frame = bytes.fromhex('fe0f08fd')
                with self.assertRaises(RuntimeError):
                    client.send_control(frame)
                client.heartbeat()
                raw, address = server.recvfrom(2048)
                self.assertEqual(decode_packet(raw).kind, 2)
                self.assertEqual(raw[9:20], b'test' + bytes(7))
                server.sendto(identity.packet(3), address)
                self.assertIsNone(client.receive())
                self.assertTrue(client.online)
                client.send_control(frame)
                self.assertEqual(decode_packet(server.recv(2048)).payload, frame)
                for kind, data in ((1, bytes(100)), (6, frame), (5, b'')):
                    server.sendto(host.packet(kind, data), address)
                    packet = client.receive()
                    self.assertEqual((packet.kind, packet.payload), (kind, data))
                server.sendto(Identity('N0TEST', 1).packet(6, frame), address)
                self.assertIsNone(client.receive())
                with self.assertRaises(ValueError):
                    client.send_control(bytes.fromhex('fe16140000fd'))
