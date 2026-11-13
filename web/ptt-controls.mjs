import { pcmRms } from './receive-audio.mjs';

export function encodeALaw(sample) {
  const sign = sample >= 0 ? 0x80 : 0;
  const magnitude = Math.min(32767, sample >= 0 ? sample : -sample - 1);
  let segment = 0;
  for (let bound = 256; segment < 7 && magnitude >= bound; bound *= 2) segment++;
  const step = (magnitude >> (segment ? segment + 3 : 4) & 15);
  return (sign | (segment << 4) | step) ^ 0x55;
}

export function mountPtt({ buttons, send, worklet, notify, onBlocked, onLevel, onActivity, spaceShortcut = false }) {
  let state, gesture, lastStop;
  let requestedWhileBlocked = false;
  let requestingMic = false;
  let closed = false;
  const supported = globalThis.isSecureContext && !!navigator.mediaDevices?.getUserMedia;

  function radioReady() {
    return state?.tx_enabled && state.online && state.power === 'on';
  }

  function available() {
    return supported && radioReady() && !state.busy && (!state.tx || state.tx_session === lastStop?.sessionId) && !requestingMic;
  }

  function updateControls() {
    for (const button of buttons) {
      const held = gesture?.button === button;
      button.disabled = !gesture && !available();
      button.title = !supported ? '麦克风需要 HTTPS' :
        !state?.tx_enabled ? '桥接尚未启用实机发射' :
        requestingMic ? '等待麦克风授权' :
        !state.online ? '软机头未联网，请先联网' :
        state.power === 'off' ? '机身已关机，请先开机' :
        (!radioReady() || !state.host_fresh) ? '正在等待机身回传。若持续无法恢复，请检查机身盒子是否在线' :
        !gesture && !available() ? '机身正在处理上一条操作，请稍等，再重新按下 PTT' :
        '按住启用麦克风并发射，松手停止';
      button.setAttribute('aria-pressed', String(held));
      button.classList.toggle('pressed', held);
    }
    if (requestedWhileBlocked) {
      requestedWhileBlocked = !available();
      onBlocked(requestedWhileBlocked ? buttons[0].title : '');
    }
  }

  function release() {
    const previous = gesture;
    if (!previous) return;
    gesture = null;
    clearTimeout(previous.startupTimer);
    previous.finishSync?.();
    onLevel?.(0);
    if (previous.started) {
      const done = send('tx-stop', previous.token).then(() => true, () => false);
      lastStop = { sessionId: previous.sessionId, done };
    }
    onActivity?.();
    if (previous.node) previous.node.port.onmessage = null;
    previous.stream?.getTracks().forEach(track => track.stop());
    if (previous.context && previous.context.state !== 'closed') previous.context.close().catch(() => {});
    updateControls();
  }

  function setState(next) {
    state = next;
    if (gesture) {
      const ownsTx = gesture.sessionId && state?.tx_session === gesture.sessionId;
      if (ownsTx) gesture.confirmed = true;
      if (state?.host_fresh) gesture.finishSync?.();
      if (!radioReady() ||
          (!gesture.started && (state.busy || (state.tx && state.tx_session !== lastStop?.sessionId))) ||
          (gesture.started && !state.host_fresh) || (gesture.confirmed && !ownsTx)) release();
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
    onActivity?.();
    updateControls();
    if (!state.host_fresh) {
      current.sync = new Promise(resolve => { current.finishSync = resolve; });
      send('ptt-sync', 'display').catch(error => fail(current, error));
    }
    // Resume during the pointer/key event, before permission or worklet awaits
    // can consume the browser's user activation.
    let resume, moduleReady;
    try {
      const context = new AudioContext({ sampleRate: 8000, latencyHint: 'interactive' });
      current.context = context;
      if (context.sampleRate !== 8000) throw new Error('浏览器未提供 8 kHz 麦克风采样');
      resume = context.resume();
      resume.catch(error => fail(current, error));
      moduleReady = context.audioWorklet.addModule(worklet);
      moduleReady.catch(error => fail(current, error));
    } catch (error) {
      fail(current, error);
      return;
    }
    requestingMic = true;
    current.startupTimer = setTimeout(() => {
      fail(current, new Error(state?.host_fresh ? '麦克风未就绪，请检查权限后重新按住 PTT' :
        '机身未回应状态查询，请检查机身盒子是否在线，再重新按住 PTT'));
    }, 5000);
    try {
      const sessionId = crypto.subtle.digest('SHA-256', new TextEncoder().encode(current.token))
        .then(hash => { current.sessionId = Array.from(new Uint8Array(hash), byte =>
          byte.toString(16).padStart(2, '0')).join(''); });
      sessionId.catch(error => fail(current, error));
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
      if (gesture !== current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      current.stream = stream;
      await sessionId;
      if (gesture !== current) return;
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
      await moduleReady;
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
        await current.sync;
        if (gesture !== current) return;
        if (lastStop && !await lastStop.done && state?.tx) {
          throw new Error('上一轮 PTT 释放尚未确认，请重新按下');
        }
        if (gesture !== current) return;
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
      const playbackVolume = target.closest('input[type="range"][data-playback-volume]');
      if (!playbackVolume && target.closest('input, select, textarea, a, [contenteditable], dialog')) return;
      const focusedButton = target.closest('button');
      const panelButton = focusedButton?.matches('[data-action], [data-mic], .audio-mute, [data-playback-gain], [data-playback-denoise]');
      if (focusedButton && !panelButton && !buttons.includes(focusedButton)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (panelButton) focusedButton.blur();
      playbackVolume?.blur();
      if (!available() && !gesture) {
        if (onBlocked) {
          requestedWhileBlocked = true;
          updateControls();
        } else {
          notify(buttons[0].title);
        }
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
