import { pcmRms } from './receive-audio.mjs';

export function encodeALaw(sample) {
  const sign = sample >= 0 ? 0x80 : 0;
  const magnitude = Math.min(32767, sample >= 0 ? sample : -sample - 1);
  let segment = 0;
  for (let bound = 256; segment < 7 && magnitude >= bound; bound *= 2) segment++;
  const step = (magnitude >> (segment ? segment + 3 : 4) & 15);
  return (sign | (segment << 4) | step) ^ 0x55;
}

export function mountPtt({ buttons, send, worklet, notify, onLevel, spaceShortcut = false }) {
  let state, gesture;
  let requestingMic = false;
  let closed = false;
  const supported = globalThis.isSecureContext && !!navigator.mediaDevices?.getUserMedia;

  function radioReady() {
    return state?.tx_enabled && state.online && state.host_fresh && state.power === 'on';
  }

  function available() {
    return supported && radioReady() && !state.busy && !state.tx && !state.tx_releasing && !requestingMic;
  }

  function updateControls() {
    for (const button of buttons) {
      const held = gesture?.button === button;
      button.disabled = !gesture && !available();
      button.title = !supported ? '麦克风需要 HTTPS' :
        !state?.tx_enabled ? '桥接尚未启用实机发射' :
        requestingMic ? '等待麦克风授权' : !radioReady() ? '等待机身状态同步' :
        !gesture && !available() ? '机身正在操作或释放 PTT' : '按住启用麦克风并发射，松手停止';
      button.setAttribute('aria-pressed', String(held));
      button.classList.toggle('pressed', held);
    }
  }

  function release() {
    const previous = gesture;
    if (!previous) return;
    gesture = null;
    clearTimeout(previous.startupTimer);
    onLevel?.(0);
    if (previous.started) send('tx-stop', previous.token).catch(() => {});
    if (previous.node) previous.node.port.onmessage = null;
    previous.stream?.getTracks().forEach(track => track.stop());
    if (previous.context && previous.context.state !== 'closed') previous.context.close().catch(() => {});
    updateControls();
  }

  function setState(next) {
    state = next;
    if (gesture) {
      if (state?.tx && gesture.started) gesture.confirmed = true;
      if (!radioReady() || state.tx_releasing ||
          (!gesture.started && (state.busy || state.tx)) ||
          (gesture.confirmed && !state.tx)) release();
    }
    updateControls();
  }

  function fail(current, error) {
    if (gesture !== current) return;
    release();
    notify(error.name === 'NotAllowedError' ? '请允许浏览器使用麦克风，再按住 PTT' : error.message);
  }

  async function press(button) {
    if (gesture || closed || document.hidden || !available()) return;
    const current = { token: crypto.randomUUID().replaceAll('-', ''), button, frames: [] };
    gesture = current;
    updateControls();
    // Resume during the pointer/key event, before permission or worklet awaits
    // can consume the browser's user activation.
    let resume;
    try {
      const context = new AudioContext({ sampleRate: 8000, latencyHint: 'interactive' });
      current.context = context;
      if (context.sampleRate !== 8000) throw new Error('浏览器未提供 8 kHz 麦克风采样');
      resume = context.resume();
      resume.catch(error => fail(current, error));
    } catch (error) {
      fail(current, error);
      return;
    }
    requestingMic = true;
    current.startupTimer = setTimeout(() => {
      fail(current, new Error('麦克风未就绪，请检查权限后重新按住 PTT'));
    }, 5000);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
      if (gesture !== current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      current.stream = stream;
      stream.getAudioTracks()[0].addEventListener('ended', () => {
        if (gesture === current) release();
      }, { once: true });
    } catch (error) {
      fail(current, error);
      return;
    } finally {
      requestingMic = false;
      updateControls();
    }

    try {
      const context = current.context;
      await context.audioWorklet.addModule(worklet);
      if (gesture !== current) return;
      const node = new AudioWorkletNode(context, 'mic-frames');
      current.node = node;
      const silent = context.createGain();
      silent.gain.value = 0;
      node.connect(silent).connect(context.destination);
      context.createMediaStreamSource(current.stream).connect(node);
      node.port.onmessage = event => sendFrame(current, event.data);
      await resume;
    } catch (error) {
      fail(current, error);
    }
  }

  async function sendFrame(current, data) {
    if (gesture !== current) return;
    if (onLevel) {
      current.level = pcmRms(data);
      if (current.ready) onLevel(current.level);
    }
    for (let offset = 0; offset < data.length; offset += 100) {
      const frame = data.subarray(offset, offset + 100);
      if (frame.length !== 100) break;
      current.frames.push(Array.from(frame, sample => encodeALaw(sample).toString(16).padStart(2, '0')).join(''));
    }
    // Retain at most 75 ms so a slow connection cannot build a speech backlog.
    if (current.frames.length > 6) current.frames.splice(0, current.frames.length - 6);
    if (current.busy || !current.frames.length) return;
    current.busy = true;
    try {
      if (!current.started) {
        clearTimeout(current.startupTimer);
        current.started = true;
        await send('tx-start', current.token);
        if (gesture !== current) {
          send('tx-stop', current.token).catch(() => {});
          return;
        }
        current.ready = true;
        onLevel?.(current.level);
      }
      while (gesture === current && current.frames.length) {
        await send('tx-audio', current.token, current.frames.splice(0, 6).join(''));
      }
    } catch (error) {
      fail(current, error);
    } finally {
      current.busy = false;
    }
  }

  for (const button of buttons) {
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0 || button.disabled) return;
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      press(button);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) {
      button.addEventListener(type, release);
    }
    button.addEventListener('keydown', event => {
      if (![' ', 'Enter'].includes(event.key)) return;
      event.preventDefault();
      if (!event.repeat) press(button);
    });
  }
  if (spaceShortcut) {
    document.addEventListener('keydown', event => {
      if (event.code !== 'Space' || document.querySelector('dialog[open]')) return;
      const target = event.target;
      if (target.closest('input, select, textarea, a, [contenteditable], dialog')) return;
      if (target.closest('button') && !target.closest('button[data-action], button[data-mic], #ptt, #micPtt')) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (!available() && !gesture) {
        notify(buttons[0].title);
        return;
      }
      press(buttons[0]);
    }, { capture: true });
  }
  window.addEventListener('keyup', event => {
    if ([' ', 'Enter', 'Escape'].includes(event.key)) release();
  });
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
  window.addEventListener('pagehide', () => {
    closed = true;
    release();
  }, { once: true });
  updateControls();
  return { setState };
}
