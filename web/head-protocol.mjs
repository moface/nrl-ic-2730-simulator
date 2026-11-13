// IC-2730 Type 6 payloads. These functions have no network transport.
export const panelKeys = Object.freeze({
  left: Object.freeze({ main: [0x0f, 0x40], vfo: [0x0e, 0x02], mr: [0x0e, 0x01] }),
  right: Object.freeze({ main: [0x0f, 0x08], vfo: [0x0f, 0x02], mr: [0x0f, 0x04] }),
  common: Object.freeze({ moni: [0x0e, 0x04], low: [0x0e, 0x08], mw: [0x0f, 0x20], menu: [0x0f, 0x10] }),
});

const hex = bytes => bytes.map(byte => byte.toString(16).padStart(2, '0')).join(' ');
const byte = value => Number.isInteger(value) && value >= 0 && value <= 255;

export function encodePatch(offset, values) {
  if (!Number.isInteger(offset) || offset < 0 || !values.length ||
      offset + values.length > 26 || !values.every(byte)) {
    throw new RangeError('无效的机头状态区写入');
  }
  const data = values.flatMap(value => value >= 0xfd ? [0xff, value & 0x0f] : [value]);
  return hex([0xfe, offset, ...data, 0xfd]);
}

export function parseFrame(source, size) {
  const compact = source.replace(/\s/g, '').toLowerCase();
  if (!/^(?:[a-f0-9]{2}){3,}$/.test(compact)) return null;
  const bytes = compact.match(/../g).map(part => parseInt(part, 16));
  if (bytes[0] !== 0xfe || bytes.at(-1) !== 0xfd) return null;
  const offset = bytes[1];
  if (bytes.length === 3 && (offset === 0xf0 || offset === 0xf1)) return { special: offset };
  const wire = bytes.slice(2, -1);
  const data = [];
  for (let i = 0; i < wire.length; i++) {
    const value = wire[i];
    if (value === 0xff) {
      const suffix = wire[++i];
      if (![0x0d, 0x0e, 0x0f].includes(suffix)) return null;
      data.push(0xf0 | suffix);
    } else {
      if (value >= 0xfd) return null;
      data.push(value);
    }
  }
  return data.length && offset + data.length <= size ? { offset, data } : null;
}

export function displayMeterLevel(labels, steps, meterBytes) {
  // On-air calibration: 0x03, 0x07 and 0x3F light 4, 6 and 12 segments.
  const bars = steps == null ? steps : steps * 2;
  if (!labels.includes('TX')) return bars == null ? bars : Math.min(9, bars);
  if ((meterBytes?.[1] & 0x40) && bars > 0) return Math.min(12, bars);
  // The bridge briefly retains TX after the radio's raw flag drops.
  if (labels.includes('LOW')) return 4;
  if (labels.includes('MID')) return 6;
  return 12;
}

export function parseDisplayText(raw) {
  const digits = raw.slice(0, 6).replaceAll('O', '0');
  const khz = Number(digits);
  const isFrequency = /^\d{6}$/.test(digits) &&
    ((khz >= 118000 && khz <= 174000) || (khz >= 375000 && khz <= 550000));
  const tail = raw.slice(7);
  const frequency = isFrequency ? digits.slice(0, 3) + '.' + digits.slice(3) : null;
  const fine = isFrequency ? ({ '2': 25, '5': 50, '7': 75 })[raw[6]] ?? null : null;
  return {
    raw,
    frequency,
    fine,
    fullFrequency: fine === null ? frequency : frequency + fine,
    channel: isFrequency && /^\d{3}$/.test(tail) ? tail : null,
  };
}

export class HostDisplay {
  #cells = Array(32).fill(null);

  ingest(payload) {
    const frame = parseFrame(payload, this.#cells.length);
    if (!frame || 'special' in frame) return false;
    this.#cells.splice(frame.offset, frame.data.length, ...frame.data);
    return true;
  }

  get bands() {
    return [3, 17].map(offset => {
      const raw = this.#cells.slice(offset, offset + 10)
        .map(value => value >= 32 && value < 127 ? String.fromCharCode(value) : '?').join('');
      return parseDisplayText(raw);
    });
  }
}

const output = (payload, atMs = 0, type = 6, status = 0) => ({ atMs, type, status, payload });

export class HeadCommands {
  #counters = [null, null];
  #ptt = false;

  // Counters require an explicit baseline. They cannot be recovered from LCD text.
  seedDials(left, right) {
    if (![left, right].every(byte)) throw new RangeError('旋钮计数须为 0 到 255');
    this.#counters = [left, right];
  }

  key(key, side, held = false) {
    const table = Object.hasOwn(panelKeys, side) ? panelKeys[side] : null;
    const group = Object.hasOwn(panelKeys.common, key) ? panelKeys.common : table;
    const mapping = group && Object.hasOwn(group, key) ? group[key] : null;
    if (!mapping || this.#ptt || (held && key !== 'menu')) return [];
    const [offset, mask] = mapping;
    return [output(encodePatch(offset, [mask])), output(encodePatch(offset, [0]), held ? 1000 : 180)];
  }

  dial(side, direction) {
    if (!['left', 'right'].includes(side) || ![-1, 1].includes(direction)) {
      throw new RangeError('每次调谐只接受左段或右段的一格转动');
    }
    if (this.#ptt) return [];
    const band = side === 'left' ? 0 : 1;
    if (this.#counters[band] === null) throw new Error('旋钮计数尚未同步');
    const value = (this.#counters[band] + direction) & 255;
    this.#counters[band] = value;
    return [output(encodePatch(0x10 + band, [value]))];
  }

  ptt(pressed) {
    if (typeof pressed !== 'boolean') throw new TypeError('PTT 状态必须为布尔值');
    if (this.#ptt === pressed) return [];
    const priorStatus = this.#ptt ? 4 : 0;
    this.#ptt = pressed;
    const status = pressed ? 4 : 0;
    return [
      output(encodePatch(0x16, [pressed ? 0x14 : 0x04, 0, 0]), 0, 6, priorStatus),
      output('', 0, 5, status),
    ];
  }
}
