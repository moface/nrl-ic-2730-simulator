"""Single-owner NRL soft-head session. All UDP writes run on the worker."""
from collections import deque
from hashlib import sha256
from queue import Empty, Full, Queue
from threading import Event, Lock, Thread
from time import monotonic, sleep

from .nrl_endpoint import NrlEndpoint
from .lcd import apply_patch, decode_patch, text_cells, frequency_candidate

LEASE = 0.35
HOST_FRESH_TIMEOUT = 3
DISPLAY_POLL_INTERVAL = 2
TX_LIMIT = 60
RELEASE_DELAYS = (0, .07, .18, .45, .85, 1.4)
RELEASE = ((6, bytes.fromhex('fe16040000fd'), 4), (5, b'', 0))
PRESS = ((6, bytes.fromhex('fe16140000fd'), 0), (5, b'', 4))
KEYS = {
    'left-main': (0x0f, 0x40), 'right-main': (0x0f, 0x08),
    'left-vfo': (0x0e, 0x02), 'right-vfo': (0x0f, 0x02),
    'left-mr': (0x0e, 0x01), 'right-mr': (0x0f, 0x04),
    'moni': (0x0e, 0x04), 'low': (0x0e, 0x08),
    'mw': (0x0f, 0x20), 'menu': (0x0f, 0x10),
}

STARTUP_PANEL = bytes.fromhex('fe000001313030303030323030303030000000002121747444000000fd')
DIAL_STEPS = {'left-up': (0, 1), 'left-down': (0, -1),
              'right-up': (1, 1), 'right-down': (1, -1)}
VOLUME_FIELDS = {'volume-left': (0x12, 74), 'volume-right': (0x13, 74)}
SQL_FIELDS = {'sql-left': (0x14, 255), 'sql-right': (0x15, 255)}
PANEL_LEVELS = {**VOLUME_FIELDS, **SQL_FIELDS}
STARTUP_LEVELS = {name: STARTUP_PANEL[offset + 2] for name, (offset, _) in PANEL_LEVELS.items()}


def validate_startup_levels(levels):
    if not isinstance(levels, dict) or levels.keys() != PANEL_LEVELS.keys():
        raise ValueError('开机需要提供左右音量和静噪的位置')
    for name, (_, maximum) in PANEL_LEVELS.items():
        value = levels[name]
        if type(value) is not int or not 1 <= value <= maximum:
            raise ValueError('旋钮设定超出范围')


def encode_control_bytes(offset, values):
    encoded = bytearray((0xfe, offset))
    for value in values:
        encoded.extend((0xff, value & 0x0f) if value >= 0xfd else (value,))
    encoded.append(0xfd)
    return bytes(encoded)


HM207_KEYS = {
    'main': 0x32, 'vfo': 0x38, 'up': 0x12, 'down': 0x02,
    'volup': 0x71, 'voldown': 0x61, 'sqlup': 0x51, 'sqldown': 0x41,
    'f1': 0x18, 'f2': 0x14, 'ent': 0x08, 'clr': 0x04,
    'decimal': 0x48, 'ce': 0x42,
    '1': 0x78, '2': 0x74, '3': 0x72, '4': 0x68, '5': 0x64,
    '6': 0x62, '7': 0x58, '8': 0x54, '9': 0x52, '0': 0x44,
}
METER_LEVELS = {0: 0, 1: 1, 3: 2, 7: 3, 15: 4, 31: 5, 63: 6}
MIC_KEYS = {
    ('step', 'up'): 0x12, ('step', 'down'): 0x02,
    ('volume', 'up'): 0x71, ('volume', 'down'): 0x61,
}


DUPLEX_LABELS = {0x20: 'DUP+', 0x30: 'DUP−'}
TONE_LABELS = {
    (0x04, False): 'T', (0x0e, False): 'TSQL', (0x09, False): 'DTCS',
    (0x06, True): 'TSQL-R', (0x01, True): 'DTCS-R',
}


def band_flags(primary, secondary):
    labels = []
    if primary is not None:
        if primary & 0x80:
            labels.append('MAIN')
        if primary & 0x40:
            labels.append('TX')
        if (duplex := DUPLEX_LABELS.get(primary & 0x30)):
            labels.append(duplex)
        reverse = secondary is not None and bool(secondary & 0x80)
        if (tone := TONE_LABELS.get((primary & 0x0f, reverse))):
            labels.append(tone)
    if secondary is not None:
        if secondary & 0x40:
            labels.append('BUSY')
        if (power := {0x10: 'MID', 0x20: 'LOW'}.get(secondary & 0x30)):
            labels.append(power)
        if secondary & 0x08:
            labels.append('NAR')
        if secondary & 0x04:
            labels.append('AM')
        if secondary & 0x02:
            labels.append('MR')
            if secondary & 0x01:
                labels.append('SKIP')
    return labels


class WakeHandshake:
    PROBE = bytes.fromhex('fef0fd')
    ANSWER = bytes.fromhex('fef1fd')
    POLL = bytes.fromhex('fe0000fd')
    RELEASE = bytes.fromhex('fe16040000fd')

    def __init__(self, now, levels=None):
        self.levels = dict(STARTUP_LEVELS if levels is None else levels)
        registers = bytearray(STARTUP_PANEL[2:-1])
        for name, value in self.levels.items():
            registers[PANEL_LEVELS[name][0]] = value
        self.startup_panel = encode_control_bytes(0, registers)
        self.started = now
        self.next_probe = now
        self.last_answer = None
        self.snapshot_at = None
        self.pressed_at = None
        self.released = False
        self.snapshots = 0
        self.boot_seen = False
        self.poll_sent = False
        self.interrupted = False

    @property
    def phase(self):
        if self.released or self.boot_seen:
            return 'waiting'
        return 'pressing' if self.pressed_at is not None else 'handshake'

    def observe(self, payload, now, send):
        if self.interrupted or payload not in (self.PROBE, self.ANSWER) or self.released or self.boot_seen:
            return
        if self.snapshot_at is not None or self.snapshots >= 4:
            return
        if self.last_answer is not None and now - self.last_answer < .09:
            return
        if self.pressed_at is not None and now - self.pressed_at > .5:
            return
        send(6, self.ANSWER)
        self.last_answer = now
        self.snapshot_at = now + .031

    def tick(self, now, send):
        if self.interrupted:
            if self.pressed_at is not None and now - self.pressed_at >= 1.2:
                self.release(send)
            return
        if self.pressed_at is None and self.snapshot_at is None and not self.boot_seen:
            if now - self.started < .55 and now >= self.next_probe:
                send(6, self.PROBE)
                self.next_probe = now + .01
            elif now - self.started >= .55 and not self.poll_sent:
                send(6, self.POLL)
                self.poll_sent = True
        if self.snapshot_at is not None and now >= self.snapshot_at:
            self.snapshot_at = None
            if not self.released and not self.boot_seen:
                send(6, self.startup_panel)
                self.snapshots += 1
                if self.pressed_at is None:
                    self.pressed_at = now
                    self.next_probe = now + .1
        if self.pressed_at is None:
            return
        if not self.released and now - self.pressed_at >= 1.2:
            self.release(send)
        if now >= self.next_probe:
            send(6, self.POLL)
            self.next_probe = now + .1

    def release(self, send):
        if self.pressed_at is not None and not self.released:
            send(6, self.RELEASE)
            self.released = True

    def outcome(self, now, on):
        if on and (self.pressed_at is None or self.released):
            return 'on'
        if self.pressed_at is None and not self.boot_seen and now - self.started >= 1.2:
            return 'no-handshake'
        if now - self.started >= 14:
            return 'no-display'
        return None


class Ptt:
    def __init__(self, send, tx_limit=TX_LIMIT):
        self.send = send
        self.tx_limit = tx_limit
        self.owner = None
        self.session_id = None
        self.closed = deque(maxlen=256)
        self.releases = deque()
        self.audio = deque(maxlen=12)
        self.next_audio = 0

    def start(self, token, now):
        if self.owner or token in self.closed:
            raise ValueError('PTT 尚未就绪')
        self.releases.clear()
        self.owner = token
        self.session_id = sha256(token.encode()).hexdigest()
        self.deadline = now + LEASE
        self.limit = now + self.tx_limit
        self.next_audio = now
        try:
            for packet in PRESS:
                self.send(*packet)
        except OSError:
            self.stop(token, now)
            raise

    def feed(self, token, frames, now):
        self.tick(now)
        if self.owner != token:
            raise ValueError('PTT 已释放，请重新按下')
        self.deadline = min(now + LEASE, self.limit)
        self.audio.extend(frames)

    def stop(self, token, now):
        self.closed.append(token)
        if token != self.owner:
            return
        self.owner = None
        self.session_id = None
        self.audio.clear()
        self.releases.extend(now + delay for delay in RELEASE_DELAYS)
        self.tick(now)

    def tick(self, now):
        if self.owner and now >= self.deadline:
            self.stop(self.owner, now)
        while self.releases and self.releases[0] <= now:
            self.releases.popleft()
            for packet in RELEASE:
                try:
                    self.send(*packet)
                except OSError:
                    pass
        if self.owner and self.audio and now >= self.next_audio:
            self.send(1, self.audio.popleft(), 4)
            self.next_audio = max(self.next_audio + .0125, now + .010)

    def close(self):
        if self.owner:
            self.stop(self.owner, monotonic())
        while self.releases:
            sleep(max(0, self.releases[0] - monotonic()))
            self.tick(monotonic())


def empty_snapshot(allow_tx=False):
    return {
        'online': False, 'lcd': ['??????????'] * 2, 'tx': False, 'power': 'unknown',
        'busy': False, 'host_fresh': False, 'tx_enabled': allow_tx, 'tx_releasing': False, 'tx_session': None,
        'meter': [None, None], 'meter_bytes': [None, None], 'flags': [[], []], 'volume_targets': {}, 'sql_targets': {},
        'dial_ready': False, 'locked': None, 'wake_phase': None, 'wake_result': None,
    }


class AudioListeners:
    def __init__(self):
        self.lock = Lock()
        self.queues = set()

    def subscribe(self):
        queue = Queue(maxsize=24)
        with self.lock:
            self.queues.add(queue)
        return queue

    def unsubscribe(self, queue):
        with self.lock:
            self.queues.discard(queue)

    def publish(self, frame):
        with self.lock:
            for queue in self.queues:
                try:
                    queue.put_nowait(frame)
                except Full:
                    try:
                        queue.get_nowait()
                    except Empty:
                        pass
                    queue.put_nowait(frame)


class LiveHead:
    def __init__(self, address, allow_tx=False, *, identity, host_ssid, tx_limit=TX_LIMIT):
        self.address = address
        self.identity = identity
        self.host_ssid = host_ssid
        self.tx_limit = tx_limit
        self.allow_tx = allow_tx
        self.requests = Queue(maxsize=16)
        self.audio = AudioListeners()
        self.stop_event = Event()
        self.volume_targets = {}
        self.sql_targets = {}
        self.dial_counts = None
        self.wake = None
        self.wake_result = None
        self.snapshot = empty_snapshot(allow_tx)
        self.worker = Thread(target=self.run, daemon=True)
        self.worker.start()

    def request(self, action, value):
        reply = Queue(maxsize=1)
        try:
            self.requests.put_nowait((monotonic(), action, value, reply))
            return reply.get(timeout=.8)
        except (Empty, Full):
            return '控制连接繁忙'

    def close(self):
        self.stop_event.set()
        self.worker.join(timeout=2)
        return not self.worker.is_alive()

    def run(self):
        with NrlEndpoint(self.address, self.identity, self.host_ssid) as endpoint:
            endpoint.socket.settimeout(.002)
            ptt = Ptt(endpoint.send, self.tx_limit)
            try:
                self.loop(endpoint, ptt)
            finally:
                try:
                    if self.wake is not None:
                        self.wake.release(endpoint.send)
                except OSError:
                    pass
                ptt.close()

    def loop(self, endpoint, ptt):
        next_beat = next_display_poll = last_display = last_host = 0
        pending_power = None
        synchronized_session = False
        cells = [None] * 32
        scheduled = deque()
        was_on = False
        tx_seen = [0., 0.]
        while not self.stop_event.is_set():
            now = monotonic()
            try:
                if ptt.owner and (not endpoint.online or now - last_host >= HOST_FRESH_TIMEOUT):
                    ptt.stop(ptt.owner, now)
                ptt.tick(now)
                if now >= next_beat:
                    endpoint.heartbeat(4 if ptt.owner else 0)
                    next_beat = now + 2
                if not endpoint.online:
                    synchronized_session = False
                    self.dial_counts = None
                elif not synchronized_session and not scheduled and self.wake is None and not ptt.owner and not ptt.releases:
                    endpoint.send(6, WakeHandshake.PROBE)
                    synchronized_session = True
                elif (was_on and now >= next_display_poll and now - last_host >= DISPLAY_POLL_INTERVAL
                      and not scheduled and not pending_power and self.wake is None
                      and not ptt.owner and not ptt.releases):
                    # An idle display may send no updates until the next panel action.
                    next_display_poll = now + DISPLAY_POLL_INTERVAL
                    endpoint.send(6, WakeHandshake.POLL)
                if scheduled and scheduled[0][0] <= now:
                    _, payload = scheduled.popleft()
                    endpoint.send(6, payload)
                if self.wake is not None:
                    if not endpoint.online:
                        self.wake.interrupted = True
                    self.wake.tick(now, endpoint.send)
                packet = endpoint.receive()
                if packet:
                    last_host = now
                if packet and packet.kind == 6:
                    frame = decode_patch(packet.payload.hex(), 32)
                    if frame and frame['kind'] == 'patch':
                        apply_patch(cells, frame)
                        for side, offset in enumerate((0x0e, 0x1c)):
                            if frame['offset'] <= offset < frame['offset'] + len(frame['data']) and cells[offset] & 0x40:
                                tx_seen[side] = now
                        last_display = now
                        if self.wake is not None:
                            display = [text_cells(cells, offset) for offset in (3, 17)]
                            self.wake.boot_seen |= any('ICOM' in text or frequency_candidate(text) for text in display)
                    if self.wake is not None and endpoint.online:
                        self.wake.observe(packet.payload, now, endpoint.send)
                if packet and packet.kind == 1 and not ptt.owner:
                    self.audio.publish(packet.payload)
            except OSError:
                if ptt.owner:
                    ptt.stop(ptt.owner, now)
                self.stop_event.wait(.02)
            lcd = [text_cells(cells, offset) for offset in (3, 17)]
            power = 'unknown'
            if not endpoint.online:
                was_on = False
            elif now - last_host < 30 and lcd == [' ' * 10] * 2:
                power = 'off'
                was_on = False
            elif last_display and now - last_host < 30 and (was_on or any(frequency_candidate(text) for text in lcd)):
                power = 'on'
                was_on = True
            host_fresh = now - last_host < HOST_FRESH_TIMEOUT
            if pending_power and not scheduled:
                target, deadline = pending_power
                if power == target or now >= deadline:
                    pending_power = None
            if self.wake is not None:
                wake_result = self.wake.outcome(now, power == 'on')
                if wake_result is not None:
                    if self.wake.pressed_at is None or self.wake.released:
                        if wake_result == 'on' and self.wake.pressed_at is not None and not self.wake.interrupted:
                            self.dial_counts = [0, 0]
                            self.volume_targets.update({name: self.wake.levels[name] for name in VOLUME_FIELDS})
                            self.sql_targets.update({name: self.wake.levels[name] for name in SQL_FIELDS})
                        self.wake_result = wake_result
                        self.wake = None
            if power == 'off' or not endpoint.online:
                self.volume_targets.clear()
                self.sql_targets.clear()
                self.dial_counts = None
                cells[0x1f] = None
            meter_bytes = [cells[offset:offset + 3] if host_fresh and power == 'on' else None
                           for offset in (0x0d, 0x1b)]
            meter = [METER_LEVELS.get(cells[offset]) if host_fresh and power != 'off' else None
                     for offset in (0x0d, 0x1b)]
            flags = [band_flags(cells[offset], cells[offset + 1])
                     if endpoint.online and power != 'off' and now - last_host < 30 else []
                     for offset in (0x0e, 0x1c)]
            if endpoint.online and power != 'off':
                for side, labels in enumerate(flags):
                    if now - tx_seen[side] < .35 and 'TX' not in labels:
                        labels.append('TX')
            lock_bits = cells[0x1f] if endpoint.online and power == 'on' else None
            locked = bool(lock_bits & 0x08) if lock_bits is not None else None
            self.snapshot = {'online': endpoint.online, 'lcd': lcd, 'power': power,
                             'meter': meter, 'meter_bytes': meter_bytes, 'flags': flags, 'locked': locked, 'dial_ready': self.dial_counts is not None, 'volume_targets': self.volume_targets.copy(),
                             'sql_targets': self.sql_targets.copy(),
                             'wake_phase': self.wake.phase if self.wake else None, 'wake_result': self.wake_result,
                             'busy': bool(scheduled or pending_power or self.wake), 'tx': bool(ptt.owner),
                             'host_fresh': host_fresh, 'tx_enabled': self.allow_tx,
                             'tx_releasing': bool(ptt.releases), 'tx_session': ptt.session_id}
            try:
                queued, action, value, reply = self.requests.get_nowait()
            except Empty:
                continue
            try:
                if now - queued > .25 and action != 'tx-stop':
                    raise ValueError('操作已过期')
                if (pending_power or self.wake is not None) and action != 'tx-stop':
                    raise ValueError('等待机身电源回传')
                self.act(action, value, now, endpoint, ptt, scheduled, power, host_fresh)
                if action == 'power' and value in ('off', 'recover-off') and scheduled:
                    pending_power = ('off', now + 10)
                reply.put_nowait(None)
            except (OSError, ValueError) as error:
                reply.put_nowait(str(error))

    def act(self, action, value, now, endpoint, ptt, scheduled, power, host_fresh):
        if action == 'tx-stop':
            ptt.stop(value, now)
            return
        if not endpoint.online:
            raise ValueError('NRL 心跳尚未确认')
        if action == 'tx-audio':
            token, frames = value
            ptt.feed(token, frames, now)
            return
        if action == 'ptt-sync':
            if not self.allow_tx or power != 'on' or scheduled or ptt.owner:
                raise ValueError('机身暂时无法查询状态，请稍后重新按住 PTT')
            if not host_fresh:
                endpoint.send(6, WakeHandshake.POLL)
            return
        if scheduled or ptt.owner or (ptt.releases and action != 'tx-start'):
            raise ValueError('机头正在处理上一条操作')
        if action == 'tx-start':
            if not self.allow_tx or power != 'on' or not host_fresh:
                raise ValueError('实机发射未启用或机身状态未同步')
            ptt.start(value, now)
            return
        if action in ('key', 'key-hold') and value in KEYS and power == 'on':
            offset, mask = KEYS[value]
            endpoint.send_control(bytes((0xfe, offset, mask, 0xfd)))
            duration = 1.2 if action == 'key-hold' else .18
            scheduled.append((now + duration, bytes((0xfe, offset, 0, 0xfd))))
        elif action == 'dial' and value in DIAL_STEPS and power == 'on':
            if self.dial_counts is None:
                raise ValueError('左右调谐计数未同步，请从调试页开机')
            side, direction = DIAL_STEPS[value]
            count = (self.dial_counts[side] + direction) & 0xff
            endpoint.send_control(encode_control_bytes(0x10 + side, (count,)))
            self.dial_counts[side] = count
        elif action in PANEL_LEVELS and power == 'on':
            offset, maximum = PANEL_LEVELS[action]
            if type(value) is not int or not 1 <= value <= maximum:
                raise ValueError('旋钮设定超出范围')
            endpoint.send_control(encode_control_bytes(offset, (value,)))
            targets = self.volume_targets if action in VOLUME_FIELDS else self.sql_targets
            targets[action] = value
        elif power == 'on' and ((action == 'mic' and value in HM207_KEYS) or (action, value) in MIC_KEYS):
            code = HM207_KEYS[value] if action == 'mic' else MIC_KEYS[action, value]
            for delay, b, c in ((0, 0x0c, 0x48), (.065, 0x0c, 8), (.16, 4, 8)):
                scheduled.append((now + delay, bytes((0xfe, 0x16, b, c, code, 0xfd))))
        elif action == 'power-on-levels' or (action == 'power' and value == 'on'):
            if action == 'power-on-levels':
                validate_startup_levels(value)
            if power != 'on':
                self.wake_result = None
                self.wake = WakeHandshake(now, value if action == 'power-on-levels' else None)
        elif action == 'power' and value in ('off', 'recover-off'):
            if value == 'recover-off' and (power != 'unknown' or not host_fresh):
                raise ValueError('仅在机身在线且显示未同步时恢复关机')
            if value == 'off' and power == 'off':
                return
            if value == 'off' and power != 'on':
                raise ValueError('需确认机身已开机才能关机')
            self.wake_result = None
            scheduled.extend(((now, bytes.fromhex('fe16440000fd')),
                              (now + 1.2, WakeHandshake.RELEASE)))
        else:
            raise ValueError('操作未确认或机身状态未同步')
