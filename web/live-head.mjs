import { mountReceiveAudio } from './receive-audio.mjs';
import { displayMeterLevel, parseDisplayText } from './head-protocol.mjs';

const headers = { 'X-Softhead-Audio': '1', 'Content-Type': 'application/json' };

import { mountPtt } from './ptt-controls.mjs';
export { encodeALaw } from './ptt-controls.mjs';

export async function command(action, value, audio, endpoint = 'live/action') {
  const response = await fetch(endpoint, {
    method: 'POST', headers, keepalive: action === 'tx-stop',
    body: JSON.stringify({ action, value, audio }),
    signal: AbortSignal.timeout(value === 'shutdown-and-off' ? 17000 : action === 'network' ? 4500 : 700),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result || result.error) {
    const error = new Error(result?.error || `操作未送达（HTTP ${response.status}）`);
    if (response.status === 409 && result?.confirm_network === true) error.confirmNetwork = true;
    throw error;
  }
}

export function watchPanelActivity(getState, endpoint = 'live/action') {
  let lastSent = -Infinity;
  function record(event) {
    if (!event.isTrusted || event.repeat || !getState()?.network_enabled ||
        performance.now() - lastSent < 1000) return;
    lastSent = performance.now();
    command('activity', 'web', undefined, endpoint).catch(() => {});
  }
  for (const type of ['pointerdown', 'keydown', 'input', 'wheel']) {
    document.addEventListener(type, record, { capture: true, passive: true });
  }
}

function bandPanel(side, title) {
  return `
    <div class="live-band" aria-label="${title}">
      <span class="live-band-label">${title}</span>
      <div class="live-flags" aria-label="状态标记"></div>
      <output class="live-frequency">—</output>
      <span class="live-channel" hidden>信道 <b></b></span>
      <div class="live-meter">
        <span>场强</span>
        <div class="live-meter-bars" role="meter" aria-valuemin="0" aria-valuemax="12"
             aria-valuenow="0" aria-label="${title}接收场强"></div>
        <span class="live-meter-value">—</span>
      </div>
      <div class="live-band-keys">
        <button data-key="${side}-main" aria-label="${title} MAIN/BAND">MAIN / BAND</button>
        <button data-key="${side}-vfo" aria-label="${title} VFO/MHz">VFO / MHz</button>
        <button data-key="${side}-mr" aria-label="${title} MR/CALL">MR / CALL</button>
      </div>
      <div class="live-band-adjust">
        <span>调谐</span>
        <button data-command="dial:${side}-down" aria-label="${title}调谐减">−</button>
        <button data-command="dial:${side}-up" aria-label="${title}调谐加">＋</button>
      </div>
      <div class="live-band-adjust">
        <label for="volume-${side}">音量</label>
        <button data-volume-step="-1" aria-label="${title}音量减">−</button>
        <button data-volume-step="1" aria-label="${title}音量加">＋</button>
        <input id="volume-${side}" aria-label="${title}机身音量" type="range" min="1" max="74"
               value="30" data-volume="volume-${side}" disabled>
        <output class="live-volume-value">未设置</output>
      </div>
      <div class="live-band-adjust">
        <label for="sql-${side}">静噪</label>
        <input id="sql-${side}" aria-label="${title}静噪" type="range" min="1" max="255"
               value="80" data-sql="sql-${side}" disabled>
        <output class="live-volume-value">未设置</output>
      </div>
    </div>`;
}

function mount() {
  const panel = document.createElement('section');
  panel.className = 'protocol-preview';
  panel.innerHTML = `
    <h2>调试页</h2>
    <p class="live-link" role="status">连接中</p>
    <div class="live-lcd" aria-label="机身液晶">
      ${bandPanel('left', '左段')}
      ${bandPanel('right', '右段')}
    </div>
    <p class="dial-sync" role="status"></p>
    <p class="wake-status" role="status"></p>
    <p>
      <button id="live-power" disabled>电源</button>
      <span>长按开关机，开机时短按切换网页静音</span>
    </p>
    <div class="live-band-keys">
      <button data-key="moni">MONI / DUP</button>
      <button data-key="low">LOW / DTMF</button>
      <button data-key="mw">MW</button>
      <button data-key="menu">MENU</button>
    </div>
    <p>
       <button id="live-ptt" disabled aria-pressed="false">按住 PTT</button></p>
    <p class="live-result" role="status"></p>
  `;
  document.querySelector('#live-page').replaceChildren(panel);
  const receiver = mountReceiveAudio(panel);
  const link = panel.querySelector('.live-link');
  const bands = [...panel.querySelectorAll('.live-band')].map(band => ({
    frequency: band.querySelector('.live-frequency'),
    flags: band.querySelector('.live-flags'),
    flagKey: '',
    channel: band.querySelector('.live-channel'),
    channelNumber: band.querySelector('.live-channel b'),
    meter: band.querySelector('.live-meter-bars'),
    meterValue: band.querySelector('.live-meter-value'),
  }));

  for (const band of bands) {
    band.segments = Array.from({length: 12}, (_, index) => {
      const segment = document.createElement('span');
      segment.setAttribute('aria-hidden', 'true');
      band.meter.append(segment);
      return segment;
    });
  }

  function updateDisplay(rawBands, levels = [], flags = [], meterBytes = []) {
    bands.forEach((band, index) => {
      const {raw, fullFrequency, channel} = parseDisplayText(rawBands[index] || '');
      const message = raw.replaceAll('?', '').trim().replace(/\s+/g, ' ');
      const text = fullFrequency ? `${fullFrequency} MHz` : message || '—';
      if (band.frequency.textContent !== text) band.frequency.textContent = text;
      band.channel.hidden = channel === null;
      if (band.channelNumber.textContent !== (channel || '')) band.channelNumber.textContent = channel || '';
      const labels = flags[index] || [];
      const flagKey = labels.join(' ');
      if (band.flagKey !== flagKey) {
        band.flagKey = flagKey;
        const badges = labels.map(label => {
          const badge = document.createElement('span');
          badge.textContent = label;
          badge.classList.toggle('is-main', label === 'MAIN');
          badge.classList.toggle('is-tx', label === 'TX');
          badge.classList.toggle('is-busy', label === 'BUSY');
          return badge;
        });
        band.flags.replaceChildren(...badges);
      }
      const level = displayMeterLevel(labels, levels[index], meterBytes[index]);
      band.meter.setAttribute('aria-valuenow', level ?? 0);
      band.meter.setAttribute('aria-valuetext', level == null ? '未同步' : `${level} 格`);
      band.segments.forEach((segment, index) => segment.classList.toggle('lit', index < (level ?? 0)));
      band.meterValue.textContent = level == null ? '—' : `${level}`;
    });
  }
  const result = panel.querySelector('.live-result');
  const powerButton = panel.querySelector('#live-power');
  const transmit = mountPtt({
    buttons: [panel.querySelector('#live-ptt')],
    send: command, worklet: 'mic-worklet.js', notify: message => { result.textContent = message; },
  });
  let state, pageEnded = false;
  watchPanelActivity(() => state);

  const levelInputs = [...panel.querySelectorAll('[data-volume], [data-sql]')];
  for (const input of levelInputs) {
    const value = input.parentElement.querySelector('.live-volume-value');
    input.addEventListener('input', () => { value.textContent = input.value; });
    input.addEventListener('change', async () => {
      input.dataset.sending = '1';
      try {
        await command(input.dataset.volume || input.dataset.sql, input.valueAsNumber);
        result.textContent = input.dataset.sql ? '机身静噪设定已发送' : '机身音量设定已发送';
      } catch (error) {
        result.textContent = error.message;
      } finally {
        delete input.dataset.sending;
      }
    });
  }

  async function refresh() {
    try {
      const response = await fetch('live/state', { headers, signal: AbortSignal.timeout(1000) });
      if (response.status === 401) pageEnded = true;
      if (!response.ok) throw new Error(response.status === 401 ? '登录已过期，请刷新页面重新登录' : '实机连接断开');
      state = await response.json();
      updateDisplay(state.lcd, state.meter, state.flags, state.meter_bytes);
      const power = {on:'开机', off:'关机', unknown:'待同步'}[state.power];
      link.textContent = state.network_enabled === false ? (state.offline_reason === 'power-off-idle' ? '软机头已自动脱网（关机闲置超时）' : '软机头已脱网，请从实机面板联网') : state.online ? `NRL 在线 · 机身${power}${state.tx ? ' · PTT 请求保持中' : state.tx_releasing ? ' · 正在释放 PTT' : ''}` : 'NRL 离线';
    } catch (error) {
      state = null;
      updateDisplay([]);
      link.textContent = pageEnded ? error.message : '实机连接断开';
    }
    transmit.setState(state);
    const wakeStatus = {
      handshake: '正在等待机身握手…',
      pressing: '正在执行开机长按…',
      waiting: '等待机身液晶确认开机…',
      'no-handshake': '未收到机身握手，可以重新长按电源。',
      'no-display': '开机键已释放，机身液晶尚未确认开机。',
    };
    const wakeMessage = wakeStatus[state?.wake_phase] ||
      (state?.power !== 'on' && wakeStatus[state?.wake_result]) || '';
    const wakeOutput = panel.querySelector('.wake-status');
    if (wakeOutput.textContent !== wakeMessage) wakeOutput.textContent = wakeMessage;
    powerButton.disabled = !state?.online || state.busy || state.tx;
    const ready = state?.online && !state.busy && !state.tx && !state.tx_releasing && state.power === 'on';
    panel.querySelectorAll('[data-command], [data-key]').forEach(button => {
      button.disabled = !ready || (button.dataset.command?.startsWith('dial:') && !state?.dial_ready);
    });
    panel.querySelector('.dial-sync').textContent = state?.power === 'on' && !state.dial_ready
      ? '从调试页开机后可同步左右调谐。' : '';
    for (const input of levelInputs) {
      input.disabled = !ready;
      const sent = input.dataset.sql ? state?.sql_targets?.[input.dataset.sql]
        : state?.volume_targets?.[input.dataset.volume];
      for (const button of input.parentElement.querySelectorAll('[data-volume-step]')) {
        button.disabled = !ready || sent == null || !!input.dataset.sending;
      }
      if (input.matches(':active, :focus') || input.dataset.sending) continue;
      const target = sent;
      if (target != null) input.value = target;
      input.parentElement.querySelector('.live-volume-value').textContent = target ?? '未设置';
    }
    if (!pageEnded) setTimeout(refresh, 250);
  }

  async function sendOperation(action, value) {
    try {
      await command(action, value);
      result.textContent = '操作已受理，等待机身回传';
    } catch (error) {
      result.textContent = error.message;
    }
  }

  panel.addEventListener('click', event => {
    const button = event.target.closest('[data-command]');
    if (button) sendOperation(...button.dataset.command.split(':'));
    const volumeButton = event.target.closest('[data-volume-step]');
    if (volumeButton) {
      const input = volumeButton.parentElement.querySelector('[data-volume]');
      const current = state?.volume_targets?.[input.dataset.volume];
      if (current == null || input.dataset.sending) return;
      const next = Math.max(Number(input.min), Math.min(Number(input.max), current + Number(volumeButton.dataset.volumeStep)));
      if (next === current) return;
      input.value = next;
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new Event('change'));
    }
  });

  const keyReleases = [];
  panel.querySelectorAll('[data-key]').forEach(button => {
    let pressed = null;
    const startKey = () => { if (pressed === null && !button.disabled) pressed = performance.now(); };
    const finishKey = send => {
      if (pressed === null) return;
      const held = performance.now() - pressed >= 950;
      pressed = null;
      if (send && !button.disabled) sendOperation(held ? 'key-hold' : 'key', button.dataset.key);
    };
    keyReleases.push(finishKey);
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      button.setPointerCapture(event.pointerId);
      startKey();
    });
    button.addEventListener('pointerup', () => finishKey(true));
    for (const name of ['pointercancel', 'lostpointercapture', 'blur']) {
      button.addEventListener(name, () => finishKey(false));
    }
    for (const name of ['keydown', 'keyup']) {
      button.addEventListener(name, event => {
        if (!['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        if (name === 'keyup') finishKey(true);
        else if (!event.repeat) startKey();
      });
    }
    button.addEventListener('click', event => {
      if (event.detail === 0 && !button.disabled) sendOperation('key', button.dataset.key);
    });
  });

  let powerHold = null;
  function startPower() {
    if (powerHold !== null || powerButton.disabled) return;
    powerHold = setTimeout(() => {
      powerHold = -1;
      sendOperation('power', state?.power === 'on' ? 'off' : 'on');
    }, 950);
  }
  function finishPower(shortPress) {
    if (powerHold === null) return;
    clearTimeout(powerHold);
    if (shortPress && powerHold !== -1 && state?.power === 'on') {
      const muted = receiver.toggleMute();
      result.textContent = muted ? '网页接收已静音' : '网页接收已取消静音';
    }
    powerHold = null;
  }
  powerButton.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    powerButton.setPointerCapture(event.pointerId);
    startPower();
  });
  powerButton.addEventListener('pointerup', () => finishPower(true));
  for (const event of ['pointercancel', 'lostpointercapture', 'blur']) {
    powerButton.addEventListener(event, () => finishPower(false));
  }
  powerButton.addEventListener('keydown', event => {
    if (!['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    if (!event.repeat) startPower();
  });
  powerButton.addEventListener('keyup', event => {
    if (!['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    finishPower(true);
  });

  window.addEventListener('blur', () => { finishPower(false); keyReleases.forEach(release => release(false)); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      finishPower(false);
      keyReleases.forEach(release => release(false));
    }
  });
  window.addEventListener('pagehide', () => { pageEnded = true; }, { once: true });
  refresh();
}

if (document.querySelector('#live-page')) mount();
