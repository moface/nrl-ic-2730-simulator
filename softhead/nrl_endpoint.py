"""NRL2 UDP transport for a provisioned soft-head identity."""
from dataclasses import dataclass, field
import re
import socket
import struct
import time

from .protocol import decode_packet
from .lcd import decode_patch


@dataclass(frozen=True)
class Identity:
    callsign: str
    ssid: int
    model: int = 14
    password: bytes = field(default=b'', repr=False)

    def __post_init__(self):
        if not re.fullmatch(r'[A-Z0-9]{1,6}', self.callsign):
            raise ValueError('Invalid NRL callsign')
        if not 0 <= self.ssid <= 255 or not 1 <= self.model <= 255:
            raise ValueError('Invalid NRL SSID or device model')
        if not isinstance(self.password, bytes) or len(self.password) > 11:
            raise ValueError('NRL password must fit the 11-byte field')

    def packet(self, kind, payload=b'', status=0):
        header = bytearray(48)
        header[:4] = b'NRL2'
        struct.pack_into('>H', header, 4, len(header) + len(payload))
        header[9:9 + len(self.password)] = self.password
        header[20:22] = bytes((kind, status))
        callsign = self.callsign.encode('ascii')
        header[24:24 + len(callsign)] = callsign
        header[30:32] = bytes((self.ssid, self.model))
        return bytes(header) + payload


class NrlEndpoint:
    """Call heartbeat every two seconds from the bridge's event loop."""

    def __init__(self, address, identity, host_ssid=0):
        if identity.ssid == host_ssid:
            raise ValueError('Soft head and radio host must have distinct SSIDs')
        self.identity = identity
        self.host_ssid = host_ssid
        self.last_reply = None
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            self.socket.connect(address)
            self.socket.settimeout(0.25)
        except BaseException:
            self.socket.close()
            raise

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.socket.close()

    @property
    def online(self):
        return self.last_reply is not None and time.monotonic() - self.last_reply < 6

    def heartbeat(self, status=0):
        self.send(2, status=status)

    def send(self, kind, payload=b'', status=0):
        self.socket.send(self.identity.packet(kind, payload, status))

    def receive(self):
        try:
            raw = self.socket.recv(65535)
        except TimeoutError:
            return None
        try:
            packet = decode_packet(raw)
        except ValueError:
            return None
        if packet.callsign != self.identity.callsign:
            return None
        if packet.ssid == self.identity.ssid:
            if packet.kind in (2, 3):
                self.last_reply = time.monotonic()
            return None
        if packet.ssid != self.host_ssid or packet.model != 14:
            return None
        if packet.kind == 1 and len(packet.payload) == 100:
            return packet
        if packet.kind == 6 and packet.payload:
            return packet
        if packet.kind == 5 and not packet.payload:
            return packet
        return None

    def send_control(self, payload):
        if not self.online:
            raise RuntimeError('NRL heartbeat reply missing or stale')
        frame = decode_patch(payload.hex(), 26)
        if frame is None or frame['kind'] != 'patch':
            raise ValueError('Expected an IC-2730 Type 6 state patch')
        if frame['offset'] + len(frame['data']) > 0x16:
            raise ValueError('PTT and accessory state require a separate session handler')
        self.socket.send(self.identity.packet(6, payload))
