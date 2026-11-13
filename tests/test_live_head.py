import unittest
from collections import deque
from unittest.mock import Mock

from softhead.live_head import LEASE, PRESS, RELEASE, TX_LIMIT, LiveHead, Ptt, STARTUP_PANEL, WakeHandshake, band_flags
from softhead.lcd import decode_patch


class BandFlagsTests(unittest.TestCase):
    def test_capture_states(self):
        for primary, secondary, labels in (
            (0xb4, 0x42, ['MAIN', 'DUP−', 'T', 'BUSY', 'MR']),
            (0xf4, 0x02, ['MAIN', 'TX', 'DUP−', 'T', 'MR']),
            (0x00, 0x40, ['BUSY']),
            (0xa0, 0x10, ['MAIN', 'DUP+', 'MID']),
            (0x8e, 0x20, ['MAIN', 'TSQL', 'LOW']),
            (0x89, 0x20, ['MAIN', 'DTCS', 'LOW']),
            (0x86, 0xa0, ['MAIN', 'TSQL-R', 'LOW']),
            (0x81, 0xa0, ['MAIN', 'DTCS-R', 'LOW']),
            (0x80, 0x28, ['MAIN', 'LOW', 'NAR']),
            (0x80, 0x24, ['MAIN', 'LOW', 'AM']),
            (0x00, 0x07, ['AM', 'MR', 'SKIP']),
            (0x00, 0x47, ['BUSY', 'AM', 'MR', 'SKIP']),
            (0x00, 0x06, ['AM', 'MR']),
            (0x00, 0x00, []),
            (None, None, []),
        ):
            with self.subTest(primary=primary, secondary=secondary):
                self.assertEqual(band_flags(primary, secondary), labels)


class PanelCommandTests(unittest.TestCase):
    def setUp(self):
        self.head = object.__new__(LiveHead)
        self.head.dial_counts = None
        self.endpoint = Mock(online=True)
        self.ptt = Ptt(self.endpoint.send)
        self.scheduled = deque()

    def action(self, kind, value):
        self.head.act(kind, value, 10, self.endpoint, self.ptt, self.scheduled, 'on', True)

    def test_independent_dial_and_wrap(self):
        with self.assertRaises(ValueError):
            self.action('dial', 'left-up')
        self.head.dial_counts = [0, 0]
        self.action('dial', 'left-down')
        self.action('dial', 'right-up')
        self.action('dial', 'left-up')
        self.assertEqual(self.head.dial_counts, [0, 1])
        self.assertEqual([call.args[0].hex() for call in self.endpoint.send_control.call_args_list],
                         ['fe10ff0ffd', 'fe1101fd', 'fe1000fd'])

    def test_paired_short_and_long_key_release(self):
        self.action('key', 'left-main')
        self.endpoint.send_control.assert_called_with(bytes.fromhex('fe0f40fd'))
        self.assertEqual(self.scheduled.popleft(), (10.18, bytes.fromhex('fe0f00fd')))
        self.action('key-hold', 'right-mr')
        self.endpoint.send_control.assert_called_with(bytes.fromhex('fe0f04fd'))
        self.assertEqual(self.scheduled.popleft(), (11.2, bytes.fromhex('fe0f00fd')))


class WakeHandshakeTests(unittest.TestCase):
    def setUp(self):
        self.wake = WakeHandshake(10)
        self.send = Mock()

    def sent(self):
        return [call.args[1] for call in self.send.call_args_list]

    def test_waits_for_host_then_repeats_only_while_held(self):
        self.wake.tick(10, self.send)
        self.wake.tick(10.2, self.send)
        self.assertEqual(self.sent(), [WakeHandshake.PROBE] * 2)
        self.wake.observe(WakeHandshake.PROBE, 10.25, self.send)
        self.wake.tick(10.29, self.send)
        self.wake.observe(WakeHandshake.PROBE, 10.30, self.send)
        self.wake.observe(WakeHandshake.PROBE, 10.40, self.send)
        self.wake.tick(10.44, self.send)
        self.assertEqual(self.sent().count(STARTUP_PANEL), 2)
        self.wake.tick(11.50, self.send)
        self.wake.observe(WakeHandshake.PROBE, 11.51, self.send)
        self.wake.tick(11.6, self.send)
        self.assertEqual(self.sent().count(STARTUP_PANEL), 2)
        self.assertEqual(self.sent().count(WakeHandshake.RELEASE), 1)
        self.assertEqual(self.wake.outcome(12.5, True), 'on')

    def test_startup_snapshot_preserves_all_four_positions(self):
        positions = {'volume-left': 17, 'volume-right': 74, 'sql-left': 116, 'sql-right': 255}
        self.wake = WakeHandshake(10, positions)
        self.wake.observe(WakeHandshake.PROBE, 10.1, self.send)
        self.wake.tick(10.2, self.send)
        registers = decode_patch(self.sent()[-1].hex(), 26)['data']
        self.assertEqual(registers[0x10:0x17], [0, 0, 17, 74, 116, 255, 0x44])

    def test_no_handshake_sends_no_power_key(self):
        self.wake.tick(10, self.send)
        self.wake.tick(10.7, self.send)
        self.assertEqual(self.sent(), [WakeHandshake.PROBE, WakeHandshake.POLL])
        self.assertEqual(self.wake.outcome(11.21, False), 'no-handshake')

    def test_boot_before_snapshot_prevents_another_power_press(self):
        self.wake.observe(WakeHandshake.ANSWER, 10.1, self.send)
        self.wake.boot_seen = True
        self.wake.tick(10.2, self.send)
        self.assertNotIn(STARTUP_PANEL, self.sent())
        self.assertEqual(self.wake.outcome(10.3, True), 'on')

    def test_waits_for_delayed_display_without_second_press(self):
        self.wake.observe(WakeHandshake.PROBE, 10.1, self.send)
        self.wake.tick(10.2, self.send)
        self.wake.tick(11.5, self.send)
        self.assertIsNone(self.wake.outcome(23, False))
        self.assertEqual(self.wake.outcome(24, False), 'no-display')
        self.assertEqual(self.sent().count(STARTUP_PANEL), 1)


class PttTests(unittest.TestCase):
    def setUp(self):
        self.sent = []
        self.ptt = Ptt(lambda *packet: self.sent.append(packet))

    def test_press_audio_release_and_retries(self):
        self.ptt.start('a', 0)
        self.ptt.feed('a', [bytes(100)], .05)
        self.ptt.tick(.05)
        self.ptt.stop('a', .10)
        self.ptt.tick(1.51)
        self.assertEqual(self.sent, [*PRESS, (1, bytes(100), 4), *RELEASE * 6])
        with self.assertRaises(ValueError):
            self.ptt.feed('a', [bytes(100)], .41)

    def test_disconnect_lease_and_no_late_start(self):
        self.ptt.start('a', 0)
        self.ptt.tick(LEASE)
        self.assertIsNone(self.ptt.owner)
        self.assertEqual(self.sent, [*PRESS, *RELEASE])
        self.ptt.stop('b', .40)
        self.ptt.tick(1.9)
        with self.assertRaises(ValueError):
            self.ptt.start('b', 1.91)
        self.ptt.start('c', 1.92)
        with self.assertRaises(ValueError):
            self.ptt.start('d', 1.93)

    def test_continuous_mic_hits_hard_limit(self):
        self.ptt.start('a', 0)
        for i in range(1, TX_LIMIT * 10):
            self.ptt.feed('a', [bytes(100)], i / 10)
        self.assertEqual(self.ptt.owner, 'a')
        self.ptt.tick(TX_LIMIT)
        self.assertIsNone(self.ptt.owner)
        self.assertEqual(self.sent[-2:], list(RELEASE))
        self.assertFalse(self.ptt.audio)

    def test_release_attempts_both_packet_types_on_failure(self):
        def flaky(*packet):
            self.sent.append(packet)
            if packet == RELEASE[0]:
                raise OSError('injected loss')
        self.ptt = Ptt(flaky)
        self.ptt.start('a', 0)
        self.ptt.stop('a', .1)
        self.ptt.tick(1.6)
        self.assertEqual(self.sent, [*PRESS, *RELEASE * 6])

    def test_partial_press_failure_sends_release(self):
        def flaky(*packet):
            self.sent.append(packet)
            if packet == PRESS[1]:
                raise OSError('injected loss')
        self.ptt = Ptt(flaky)
        with self.assertRaises(OSError):
            self.ptt.start('a', 0)
        self.assertIsNone(self.ptt.owner)
        self.assertEqual(self.sent, [*PRESS, *RELEASE])


class LiveUdpTests(unittest.TestCase):
    def test_wake_waits_for_host_reply_and_seeds_dials(self):
        from socket import AF_INET, SOCK_DGRAM, socket
        from time import monotonic, sleep

        from softhead.nrl_endpoint import Identity
        from softhead.protocol import decode_packet

        with socket(AF_INET, SOCK_DGRAM) as radio:
            radio.bind(('127.0.0.1', 0))
            radio.settimeout(2)
            live = LiveHead(radio.getsockname(), identity=Identity("N0CALL", 3), host_ssid=0)
            try:
                heartbeat, address = radio.recvfrom(2048)
                self.assertEqual(decode_packet(heartbeat).kind, 2)
                radio.sendto(Identity('N0CALL', 3).packet(3), address)
                host = Identity('N0CALL', 0)
                radio.sendto(host.packet(6, bytes.fromhex('fe000000002020202020202020202000000000202020202020202020200000000000fd')), address)
                self.assertEqual(decode_packet(radio.recv(2048)).payload, WakeHandshake.PROBE)
                deadline = monotonic() + 1
                while live.snapshot['power'] != 'off' and monotonic() < deadline:
                    sleep(.005)
                self.assertEqual(live.snapshot['power'], 'off')
                self.assertIsNone(live.request('power', 'on'))

                for _ in range(3):
                    self.assertEqual(decode_packet(radio.recv(2048)).payload, WakeHandshake.PROBE)
                radio.sendto(host.packet(6, WakeHandshake.ANSWER), address)
                payloads = []
                while WakeHandshake.RELEASE not in payloads:
                    packet = decode_packet(radio.recv(2048))
                    if packet.kind == 2:
                        radio.sendto(Identity('N0CALL', 3).packet(3), address)
                    else:
                        payloads.append(packet.payload)
                self.assertIn(WakeHandshake.ANSWER, payloads)
                self.assertEqual(payloads.count(STARTUP_PANEL), 1)
                self.assertFalse(live.snapshot['dial_ready'])

                lcd = bytes.fromhex('fe0000000434333834354f4f3030323fb4424034333833314f4f3030380000024000fd')
                radio.sendto(host.packet(6, lcd), address)
                deadline = monotonic() + 1
                while not live.snapshot['dial_ready'] and monotonic() < deadline:
                    sleep(.005)
                self.assertEqual(live.snapshot['power'], 'on')
                self.assertEqual(live.snapshot['wake_result'], 'on')
                self.assertTrue(live.snapshot['dial_ready'])
                self.assertEqual(live.snapshot['volume_targets'], {'volume-left': 33, 'volume-right': 33})
                self.assertEqual(live.snapshot['sql_targets'], {'sql-left': 116, 'sql-right': 116})
            finally:
                live.close()

    def test_gateway_microphone_lease_over_udp(self):
        from socket import AF_INET, SOCK_DGRAM, socket
        from time import monotonic, sleep

        from softhead.live_head import LiveHead
        from softhead.nrl_endpoint import Identity
        from softhead.protocol import decode_packet

        def until(predicate):
            deadline = monotonic() + 1
            while monotonic() < deadline:
                if predicate():
                    return
                sleep(.005)
            self.fail('Live UDP state did not arrive')

        with socket(AF_INET, SOCK_DGRAM) as radio:
            radio.bind(('127.0.0.1', 0))
            radio.settimeout(1)
            live = LiveHead(radio.getsockname(), allow_tx=True, identity=Identity("N0CALL", 3), host_ssid=0)
            try:
                heartbeat, address = radio.recvfrom(2048)
                self.assertEqual(decode_packet(heartbeat).kind, 2)
                reply = Identity('N0CALL', 3)
                host = Identity('N0CALL', 0)
                radio.sendto(reply.packet(3), address)
                lcd = bytes.fromhex('fe0000000434333834354f4f3030323fb4424034333833314f4f3030380000024000fd')
                radio.sendto(host.packet(6, lcd), address)
                radio.sendto(host.packet(1, bytes([0x55]) * 100), address)
                until(lambda: live.snapshot['online'] and live.snapshot['power'] == 'on')
                self.assertEqual(live.audio.get(timeout=1), bytes([0x55]) * 100)
                sync = decode_packet(radio.recv(2048))
                self.assertEqual((sync.kind, sync.payload), (6, bytes.fromhex('fef0fd')))
                self.assertEqual(live.snapshot['meter'], [6, 0])
                self.assertEqual(live.snapshot['flags'], [['MAIN', 'DUP−', 'T', 'BUSY', 'MR'], ['MR']])
                radio.sendto(host.packet(6, bytes.fromhex('fe1c86a0fd')), address)
                until(lambda: live.snapshot['flags'][1] == ['MAIN', 'TSQL-R', 'LOW'])
                self.assertEqual(live.snapshot['flags'][0], ['MAIN', 'DUP−', 'T', 'BUSY', 'MR'])
                radio.sendto(host.packet(6, bytes.fromhex('fe1b07fd')), address)
                until(lambda: live.snapshot['meter'] == [6, 3])
                radio.sendto(host.packet(6, bytes.fromhex('fe0d00fd')), address)
                until(lambda: live.snapshot['meter'] == [0, 3])
                for action, level, expected in (
                    ('volume-left', 74, 'fe124afd'), ('volume-right', 74, 'fe134afd'),
                ):
                    self.assertIsNone(live.request(action, level))
                    self.assertEqual(decode_packet(radio.recv(2048)).payload.hex(), expected)
                    until(lambda: live.snapshot['volume_targets'].get(action) == level)
                self.assertIsNotNone(live.request('volume-right', 75))
                self.assertIsNotNone(live.request('volume-left', 75))
                self.assertIsNotNone(live.request('volume-left', True))
                for action, level, expected in (
                    ('sql-left', 54, 'fe1436fd'), ('sql-right', 255, 'fe15ff0ffd'),
                ):
                    self.assertIsNone(live.request(action, level))
                    self.assertEqual(decode_packet(radio.recv(2048)).payload.hex(), expected)
                    until(lambda: live.snapshot['sql_targets'].get(action) == level)
                for key, expected in (
                    ('sqlup', ('fe160c4851fd', 'fe160c0851fd', 'fe16040851fd')),
                    ('9', ('fe160c4852fd', 'fe160c0852fd', 'fe16040852fd')),
                ):
                    self.assertIsNone(live.request('mic', key))
                    frames = [decode_packet(radio.recv(2048)).payload.hex() for _ in expected]
                    self.assertEqual(tuple(frames), expected)
                    until(lambda: not live.snapshot['busy'])
                self.assertIsNotNone(live.request('mic', 'home'))
                for direction, expected in (
                    ('up', ('fe160c4871fd', 'fe160c0871fd', 'fe16040871fd')),
                    ('down', ('fe160c4861fd', 'fe160c0861fd', 'fe16040861fd')),
                ):
                    self.assertIsNone(live.request('volume', direction))
                    frames = [decode_packet(radio.recv(2048)) for _ in expected]
                    self.assertEqual([(p.kind, p.payload.hex()) for p in frames],
                                     [(6, frame) for frame in expected])
                    until(lambda: not live.snapshot['busy'])
                self.assertIsNone(live.request('tx-start', 'one'))
                self.assertIsNone(live.request('tx-audio', ('one', [bytes([0xd5]) * 100])))
                received = []
                for _ in range(5):
                    packet = decode_packet(radio.recv(2048))
                    received.append((packet.kind, packet.payload, packet.status))
                self.assertEqual(received, [*PRESS, (1, bytes([0xd5]) * 100, 4), *RELEASE])
                until(lambda: not live.snapshot['tx'])
                self.assertIsNotNone(live.request('tx-audio', ('one', [bytes(100)])))
            finally:
                live.close()
