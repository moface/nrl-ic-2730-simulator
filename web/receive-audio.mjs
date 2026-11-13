const SAMPLE_RATE = 8000;
const FRAME_BYTES = 100;
const START_BUFFER = 0.075;
const MAX_BUFFER = 0.25;
const DEFAULT_PLAYBACK_GAIN = 10;

export function pcmRms(samples) {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return samples.length ? Math.sqrt(sum / samples.length) / 32768 : 0;
}

function levelMeter(element) {
  let decay;
  return level => {
    clearTimeout(decay);
    // Display a 60 dB range, so normal speech remains visible at modest playback volume.
    const scaled = level > 0 ? Math.min(1, Math.max(0, 1 + Math.log10(level) / 3)) : 0;
    element.value = scaled;
    if (scaled > 0) decay = setTimeout(() => { element.value = 0; }, 150);
  };
}

export function decodeALaw(payload) {
  return Int16Array.from(payload, code => {
    const value = code ^ 0x55;
    const segment = (value >> 4) & 7;
    const low = (value & 15) << 4;
    const magnitude = segment === 0 ? low + 8 : (low + 264) << (segment - 1);
    return value & 0x80 ? magnitude : -magnitude;
  });
}

// A fetch chunk can begin or end anywhere inside a bridge record.
export class AudioRecords {
  #frame = new Uint8Array(FRAME_BYTES);
  #filled = null;

  push(chunk, onFrame) {
    for (let offset = 0; offset < chunk.length;) {
      if (this.#filled === null) {
        const kind = chunk[offset++];
        if (kind === 0) continue;
        if (kind !== 1) throw new Error('无效音频流');
        this.#filled = 0;
      }
      const length = Math.min(FRAME_BYTES - this.#filled, chunk.length - offset);
      this.#frame.set(chunk.subarray(offset, offset + length), this.#filled);
      offset += length;
      this.#filled += length;
      if (this.#filled === FRAME_BYTES) {
        onFrame(this.#frame);
        this.#filled = null;
      }
    }
  }
}

class Playout {
  #sources = new Set();
  #next = 0;

  constructor(context) {
    this.context = context;
    const boost = context.createGain();
    boost.gain.value = DEFAULT_PLAYBACK_GAIN;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -10;
    compressor.knee.value = 6;
    compressor.ratio.value = 12;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.12;
    this.input = boost;
    this.gain = context.createGain();
    boost.connect(compressor);
    compressor.connect(this.gain);
    this.gain.connect(context.destination);
  }

  reset() {
    for (const source of this.#sources) source.stop();
    this.#sources.clear();
    this.#next = 0;
  }

  push(payload, measureLevel) {
    const now = this.context.currentTime;
    if (this.#next - now > MAX_BUFFER) this.reset();
    if (this.#next < now + 0.005) this.#next = now + START_BUFFER;
    const pcm = decodeALaw(payload);
    const buffer = this.context.createBuffer(1, pcm.length, SAMPLE_RATE);
    const samples = buffer.getChannelData(0);
    let energy = 0;
    for (let i = 0; i < pcm.length; i++) {
      const sample = pcm[i] / 32768;
      samples[i] = sample;
      if (measureLevel) energy += samples[i] * samples[i];
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.input);
    source.onended = () => {
      this.#sources.delete(source);
      source.disconnect();
    };
    this.#sources.add(source);
    source.start(this.#next);
    this.#next += buffer.duration;
    if (measureLevel) return Math.min(1, Math.sqrt(energy / samples.length) * this.input.gain.value) * this.gain.gain.value;
  }
}

export function mountReceiveAudio(parent, endpoint = 'audio', { compact = false, followRadio = false } = {}) {
  const section = document.createElement('section');
  section.className = compact ? 'panel-audio' : 'protocol-audio';
  section.setAttribute('aria-label', '电台接收音频');
  section.innerHTML = compact ? `
    <button type="button" aria-pressed="false">开始监听</button>
    <p role="status">已停止</p>
    <div class="audio-levels">
      <label>接收电平 <meter min="0" max="1" value="0"></meter></label>
      <label>发射电平 <meter min="0" max="1" value="0"></meter></label>
    </div>
    <div class="audio-volume">
      <label for="playback-volume">播放音量</label>
      <input id="playback-volume" type="range" data-playback-volume min="0" max="100" value="100">
      <output for="playback-volume">100%</output>
      <button class="audio-mute" type="button" aria-pressed="false">静音</button>
      <div class="audio-gain" role="group" aria-label="播放增益">
        <span>增益</span>
        ${[1, 5, 10, 20].map(gain =>
          `<button type="button" data-playback-gain="${gain}" aria-pressed="${gain === DEFAULT_PLAYBACK_GAIN}">${gain} 倍</button>`
        ).join('')}
        <button type="button" data-playback-denoise aria-pressed="true">降噪</button>
      </div>
    </div>
  ` : `
    <h3>电台接收音频</h3>
    <button type="button">开始监听</button>
    <label>播放音量 <input type="range" data-playback-volume min="0" max="100" value="100"></label>
    <fieldset>
      <legend>SpeexDSP 接收降噪</legend>
      <button type="button" data-playback-denoise aria-pressed="false">降噪</button>
      <label>最大噪声衰减（dB） <input data-noise-suppression type="number" min="-40" max="0" step="1" value="-18"></label>
      <button type="button" data-apply-suppression>应用</button>
    </fieldset>
    <p role="status">已停止</p>
  `;
  if (compact) parent.append(section);
  else parent.prepend(section);
  const button = section.querySelector('button');
  const volume = section.querySelector('input');
  const status = section.querySelector('[role=status]');
  const [receiveMeter, transmitMeter] = section.querySelectorAll('meter');
  const showReceiveLevel = receiveMeter ? levelMeter(receiveMeter) : null;
  const showTransmitLevel = transmitMeter ? levelMeter(transmitMeter) : null;
  let controller = null;
  let context;
  let playout;
  let muted = false;
  let playbackMuted = false;
  let playbackGain = DEFAULT_PLAYBACK_GAIN;
  let radioReady = false;
  let retry = null;
  const preferenceKey = 'softhead.receive-audio.enabled';
  let enabled = true;
  if (followRadio) {
    try { enabled = localStorage.getItem(preferenceKey) !== 'false'; } catch {}
  }
  function setEnabled(value) {
    enabled = value;
    if (followRadio) {
      try { localStorage.setItem(preferenceKey, String(value)); } catch {}
    }
  }
  const setGain = () => {
    if (playout) playout.gain.gain.value = (muted || playbackMuted) ? 0 : Number(volume.value) / 100;
  };
  const volumeReadout = section.querySelector('output');
  const muteButton = section.querySelector('.audio-mute');
  const gainButtons = section.querySelectorAll('[data-playback-gain]');
  for (const gainButton of gainButtons) {
    gainButton.addEventListener('click', () => {
      playbackGain = Number(gainButton.dataset.playbackGain);
      if (playout) playout.input.gain.value = playbackGain;
      for (const option of gainButtons) {
        option.setAttribute('aria-pressed', String(option === gainButton));
      }
    });
  }
  const denoiseButton = section.querySelector('[data-playback-denoise]');
  let denoise = compact;
  let suppression = -18;
  const suppressionInput = section.querySelector('[data-noise-suppression]');
  section.querySelector('[data-apply-suppression]')?.addEventListener('click', () => {
    if (!suppressionInput.value || !suppressionInput.reportValidity()) return;
    suppression = suppressionInput.valueAsNumber;
    if (denoise && controller) {
      stop();
      start();
    }
  });
  denoiseButton?.addEventListener('click', () => {
    denoise = !denoise;
    denoiseButton.setAttribute('aria-pressed', String(denoise));
    if (controller || retry !== null) {
      stop();
      startWhenReady();
    }
  });
  let volumeBeforeMute = volume.value;
  function updateVolume() {
    setGain();
    if (volumeReadout) volumeReadout.textContent = `${volume.value}%`;
    muteButton?.setAttribute('aria-pressed', String(playbackMuted));
  }
  volume.addEventListener('input', () => {
    playbackMuted = false;
    updateVolume();
  });
  muteButton?.addEventListener('click', () => {
    playbackMuted = !playbackMuted;
    if (playbackMuted) volumeBeforeMute = volume.value;
    volume.value = playbackMuted ? '0' : volumeBeforeMute;
    updateVolume();
    if (playbackMuted) showReceiveLevel?.(0);
  });

  function stop() {
    clearTimeout(retry);
    retry = null;
    controller?.abort();
    controller = null;
    playout?.reset();
    showReceiveLevel?.(0);
    button.textContent = '开始监听';
    if (compact) button.setAttribute('aria-pressed', 'false');
    status.textContent = '已停止';
  }

  function waitForRadio() {
    button.textContent = '停止监听';
    if (compact) button.setAttribute('aria-pressed', 'true');
    status.textContent = '等待机身开机或上线';
  }

  function startWhenReady() {
    if (!enabled || controller || retry !== null) return;
    if (followRadio && !radioReady) {
      waitForRadio();
      return;
    }
    start();
  }

  function unlockPlayback(event) {
    if (!event.isTrusted || !enabled || !radioReady) return;
    if (context?.state === 'suspended') context.resume().catch(() => {});
  }

  window.addEventListener('pagehide', stop);
  if (followRadio) {
    window.addEventListener('pageshow', startWhenReady);
    window.addEventListener('click', unlockPlayback, { capture: true });
    window.addEventListener('keydown', unlockPlayback, { capture: true });
    if (enabled) waitForRadio();
  }
  button.addEventListener('click', () => {
    if (followRadio) {
      setEnabled(!enabled);
      if (enabled) startWhenReady();
      else stop();
    } else if (controller) {
      stop();
    } else {
      start();
    }
  });

  async function start() {
    const current = new AbortController();
    controller = current;
    button.textContent = '停止监听';
    if (compact) button.setAttribute('aria-pressed', 'true');
    status.textContent = '正在连接音频';
    let reader;
    try {
      if (!context) {
        context = new AudioContext({ latencyHint: 'interactive' });
        playout = new Playout(context);
        playout.input.gain.value = playbackGain;
      }
      setGain();
      if (followRadio) {
        if (context.state === 'suspended') {
          status.textContent = '点击页面以允许播放音频';
          await context.resume();
        }
      } else {
        await context.resume();
      }
      if (current.signal.aborted) return;
      const response = await fetch(denoise ? endpoint + `?denoise=speex&suppression=${suppression}` : endpoint, {
        headers: { 'X-Softhead-Audio': '1' },
        signal: current.signal,
        cache: 'no-store',
      });
      if (response.status === 501 && denoise) {
        denoise = false;
        denoiseButton.disabled = true;
        denoiseButton.setAttribute('aria-pressed', 'false');
        denoiseButton.title = '服务端未安装 SpeexDSP';
        stop();
        startWhenReady();
        return;
      }
      if (!response.ok) {
        if (response.status === 401) {
          stop();
          status.textContent = '登录已过期，请刷新页面重新登录';
          return;
        }
        throw new Error(response.status === 409 ? '已有监听窗口，请稍后重试' : '无法打开 接收音频监听');
      }
      reader = response.body.getReader();
      const records = new AudioRecords();
      status.textContent = '已连接，等待机身音频';
      while (true) {
        const { done, value } = await reader.read();
        if (done || current.signal.aborted) break;
        records.push(value, frame => {
          const level = playout.push(frame, !!showReceiveLevel);
          showReceiveLevel?.(level);
          status.textContent = '正在接收机身音频';
        });
      }
      if (!current.signal.aborted) throw new Error('监听已结束，可重新开始');
    } catch (error) {
      if (controller === current) {
        stop();
        status.textContent = error.message;
        if (followRadio && enabled && radioReady) {
          button.textContent = '停止监听';
          if (compact) button.setAttribute('aria-pressed', 'true');
          retry = setTimeout(() => {
            retry = null;
            startWhenReady();
          }, 5000);
        }
      }
    } finally {
      reader?.releaseLock();
    }
  }
  return {
    setTransmitLevel: showTransmitLevel,
    setRadioReady(ready) {
      if (!followRadio || radioReady === ready) return;
      radioReady = ready;
      if (!ready) stop();
      startWhenReady();
    },
    toggleMute() {
      muted = !muted;
      setGain();
      if (muted) showReceiveLevel?.(0);
      return muted;
    },
  };
}
