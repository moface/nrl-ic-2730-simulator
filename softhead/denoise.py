"""Streaming 8 kHz SpeexDSP preprocessing for NRL A-law audio."""
from ctypes import CDLL, POINTER, byref, c_int, c_int16, c_void_p
from ctypes.util import find_library


def decode(code):
    value = code ^ 0x55
    segment = (value >> 4) & 7
    low = (value & 15) << 4
    magnitude = (low + 264) << (segment - 1) if segment else low + 8
    return magnitude if value & 128 else -magnitude


ALAW = tuple(map(decode, range(256)))


def encode(sample):
    sign = 128 if sample >= 0 else 0
    magnitude = sample if sample >= 0 else -sample - 1
    segment = max(0, magnitude.bit_length() - 8)
    return (sign | segment << 4 | (magnitude >> (segment + 3 if segment else 4)) & 15) ^ 0x55


class SpeexDenoise:
    def __init__(self, suppression=-18):
        library = find_library('speexdsp')
        self.lib = CDLL(library or 'libspeexdsp.so.1')
        self.lib.speex_preprocess_state_init.argtypes = [c_int, c_int]
        self.lib.speex_preprocess_state_init.restype = c_void_p
        self.lib.speex_preprocess_ctl.argtypes = [c_void_p, c_int, c_void_p]
        self.lib.speex_preprocess_run.argtypes = [c_void_p, POINTER(c_int16)]
        self.lib.speex_preprocess_state_destroy.argtypes = [c_void_p]
        self.lib.speex_preprocess_state_destroy.restype = None
        self.state = self.lib.speex_preprocess_state_init(160, 8000)
        if not self.state:
            raise OSError('SpeexDSP initialization failed')
        self.pending = bytearray()
        self.output = bytearray()
        for request, value in ((0, 1), (2, 0), (18, suppression)):
            if self.lib.speex_preprocess_ctl(self.state, request, byref(c_int(value))):
                self.close()
                raise OSError('SpeexDSP configuration failed')

    def push(self, frame):
        self.pending.extend(frame)
        if len(self.pending) >= 160:
            samples = (c_int16 * 160)(*(ALAW[code] for code in self.pending[:160]))
            del self.pending[:160]
            self.lib.speex_preprocess_run(self.state, samples)
            self.output.extend(map(encode, samples))
        while len(self.output) >= 100:
            yield bytes(self.output[:100])
            del self.output[:100]

    def close(self):
        self.lib.speex_preprocess_state_destroy(self.state)
