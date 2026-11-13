"""Offline NRL2730 packet inspection. No transport or hardware access."""
from dataclasses import dataclass
import struct


@dataclass(frozen=True)
class Packet:
    kind: int
    status: int
    count: int
    callsign: str
    ssid: int
    model: int
    payload: bytes

    @property
    def remote_ptt_reported(self):
        # A Type 5 status report drives a watchdog latch; this is not TX readback.
        return bool(self.status & 4) if self.kind == 5 else None


def decode_packet(raw):
    if len(raw) < 48 or raw[:4] != b'NRL2':
        raise ValueError('Not a complete NRL2 packet')
    declared = struct.unpack_from('>H', raw, 4)[0]
    if declared != len(raw):
        raise ValueError('NRL2 declared length mismatch')
    return Packet(raw[20], raw[21], struct.unpack_from('>H', raw, 22)[0],
                  raw[24:30].rstrip(b'\0\r').decode('ascii'), raw[30], raw[31], raw[48:])


def inspect_control(frame):
    """Classify only complete short 2730 patterns evidenced in the supplied firmware.

    Unknown bytes deliberately stay unknown: no invented frequency or key mappings.
    Transport packet boundaries are not assumed to equal radio frame boundaries.
    """
    if len(frame) not in (4, 6) or frame[0] != 0xfe or frame[-1] != 0xfd:
        return {'classification':'unknown', 'hex':frame.hex()}
    if frame[1:3] == b'\x16\x14':
        return {'classification':'panel_ptt_related_on', 'firmware_state':0x88,
                'hardware_verified':False, 'hex':frame.hex()}
    if frame[1:3] == b'\x16\x04':
        return {'classification':'panel_ptt_related_off', 'firmware_state':0x08,
                'hardware_verified':False, 'hex':frame.hex()}
    return {'classification':'unknown', 'hex':frame.hex()}
