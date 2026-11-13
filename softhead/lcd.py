"""IC-2730 LCD register patches and readback."""

def decode_patch(payload, size):
    raw=bytes.fromhex(payload)
    if len(raw)<3 or raw[0]!=0xfe or raw[-1]!=0xfd:return None
    if raw.count(0xfe)!=1 or raw.count(0xfd)!=1:return None
    if raw[1] in (0xf0,0xf1) and len(raw)==3:return {'kind':'special','code':raw[1]}
    offset = raw[1]
    data = []
    wire_data = iter(raw[2:-1])
    for value in wire_data:
        if value == 0xff:
            suffix = next(wire_data, None)
            if suffix not in (0x0d, 0x0e, 0x0f):
                return None
            value = 0xf0 | suffix
        data.append(value)
    if not data or offset+len(data)>size:return None
    return {'kind':'patch','offset':offset,'data':list(data)}


def apply_patch(state, frame):
    if frame['kind']!='patch':return []
    changes=[]
    for i,value in enumerate(frame['data'],frame['offset']):
        if state[i]!=value:changes.append({'offset':i,'before':state[i],'after':value})
        state[i]=value
    return changes


def text_cells(state, offset):
    return ''.join(chr(v) if v is not None and 32<=v<127 else '?' for v in state[offset:offset+10])


def frequency_candidate(text):
    # O is observed in zero-shaped numeric cells, but this is not a universal glyph table.
    digits=text[:6].replace('O','0')
    if len(digits)!=6 or not digits.isdigit():return None
    khz=int(digits)
    return digits[:3]+'.'+digits[3:] if 118000<=khz<=174000 or 375000<=khz<=550000 else None
