import { displayMeterLevel, parseDisplayText } from './head-protocol.mjs';
import { mountReceiveAudio } from './receive-audio.mjs';
import { command, watchPanelActivity } from './live-head.mjs';
import { mountPtt } from './ptt-controls.mjs';

const debug = './debug/';
const sideName = ['left', 'right'];
const knobScales = {
  vol: { field: 'volume', count: 10, rawMax: 74, travel: 270, defaultLevel: 5 },
  sql: { field: 'sql', count: 32, rawMax: 255, travel: 300, defaultLevel: 15 },
};
for (const scale of Object.values(knobScales)) {
  scale.values = Array.from({ length: scale.count }, (_, index) =>
    1 + Math.round(index * (scale.rawMax - 1) / (scale.count - 1)));
}

export function knobLevel(kind, raw) {
  const {count, rawMax} = knobScales[kind];
  return 1 + Math.min(count - 1, Math.max(0, Math.round((raw - 1) * (count - 1) / (rawMax - 1))));
}

export function stepKnob(kind, raw, direction) {
  const {values} = knobScales[kind];
  if (direction > 0) return values.find(value => value > raw) ?? raw;
  return values.findLast(value => value < raw) ?? raw;
}

const panelKeys = ['main', 'vfo', 'mr', 'moni', 'low', 'mw', 'menu'];
const supportedMic = new Set(['main', 'vfo', 'up', 'down', 'volup', 'voldown',
  'sqlup', 'sqldown', 'ent', 'clr', 'decimal', 'ce', 'f1', 'f2', 'home', ...'0123456789']);
const screenFlags = new Set(['MAIN', 'TX', 'BUSY', 'LOW', 'MID', 'NAR', 'AM', 'MR', 'SKIP',
  'DUP+', 'DUP−', 'T', 'TSQL', 'DTCS', 'TSQL-R', 'DTCS-R']);

const idlePollMs = 250;
const scanPollMs = 40;
const scanActivityMs = 2000;

const meterPairWindowMs = 85;

function pairReceiveMeters(state, frequencies, previous, now) {
  const values = state?.meter || [];
  const [left, right] = state?.flags || [];
  const sameMode = left && right && ['AM', 'NAR'].every(flag => left.includes(flag) === right.includes(flag));
  const canPair = state?.online && state.power === 'on' && !state.tx &&
    left && right && !left.includes('TX') && !right.includes('TX') &&
    frequencies[0] && frequencies[0] === frequencies[1] && sameMode &&
    values[0] != null && values[1] != null;
  const key = canPair ? frequencies[0] : null;
  if (!key || key !== previous?.key || values[0] === values[1] ||
      (values[0] === previous.values[0] && values[1] === previous.values[1])) {
    return { key, values, until: 0 };
  }
  // The two meter fields can arrive in consecutive patches. Bound the wait so real differences still display.
  const until = previous.until || now + meterPairWindowMs;
  return now < until ? { key, values: previous.values, until } : { key, values, until: 0 };
}

function scanOptionCells(raw) {
  // Bytes 0–5 are the large LCD cells. Scan selection can leave old data in the trailing cells.
  const cells = raw.slice(0, 6);
  return /^(?:ALL|BAND|MODE|DUP|TONE|HAM|B-LINK|BANK-[A-J]|PROG ?[0-9]{1,2}|PL[0-9O])$/.test(cells.trim())
    ? cells : null;
}

function displayRows(lcd) {
  return lcd.map((raw, side) => {
    const other = scanOptionCells(lcd[1 - side] || '')?.trim();
    return other === 'HAM' && /^PL[0O]$/.test(raw.trim()) ? '' : raw;
  });
}

function menuIsActive(lcd, wasActive) {
  const left = lcd[0] || '';
  const title = left.slice(0, 5).trim();
  if (/^MENU(?: |$)/.test(left)) return true;
  if (!/^[A-Z][A-Z0-9 ]*$/.test(title)) return false;
  // The sixth cell blinks between a dash and a space in the captured menus.
  return left[5] === '-' || (wasActive && (left[5] === ' ' || left.length === 5));
}

function drawBand(raw, labels, level, meterBytes, lcdMuted) {
  const { frequency, fullFrequency, fine, channel } = parseDisplayText(raw);
  const text = scanOptionCells(raw) ?? raw.replace(/[^A-Z0-9 .+-]/g, ' ').trimEnd();
  const frequencyText = lcdMuted ? 'MUTE' : frequency || text;
  const cells = window.lcdFrequency(frequencyText);
  const meterLevel = displayMeterLevel(labels, level, meterBytes);
  const meter = Array.from({ length: 12 }, (_, index) => {
    const lit = index < (meterLevel ?? 0);
    return `<rect x="${index * 24}" y="228" width="20" height="24" opacity="${lit ? 1 : .16}"/>`;
  }).join('');
  const summary = [lcdMuted ? 'MUTE' : fullFrequency ? `${fullFrequency} MHz` : text, channel && `信道 ${channel}`, ...labels].filter(Boolean).join('，');
  return `<svg class="lcd-drawing" viewBox="0 0 520 280" preserveAspectRatio="none" role="img" aria-label="${summary || '无回显'}">
    ${window.lcdBandMarks(labels)}${cells}${window.lcdFineMarks(lcdMuted ? null : fine)}
    ${meter}${channel ? window.lcdNumber(channel, 366, 198, 150, 60) : ''}
    </svg>`;
}

export function mountRealPanel() {
  const $ = selector => document.querySelector(selector);
  const notice = $('#notice');
  let message = '';
  let operationError = '';
  let pttBlocked = '';
  let loginExpired = false;
  let hasPolled = false;
  const show = text => {
    message = text;
    operationError = '';
    renderNotice();
  };
  const warn = text => {
    operationError = text;
    renderNotice();
  };

  function renderNotice() {
    let issue = '';
    if (loginExpired) issue = '登录已过期，请刷新页面重新登录。';
    else if (hasPolled && !state) issue = '网页与桥接连接中断。请检查网络，连接恢复后再操作。';
    else if (state?.live_available === false) issue = '尚未配置 NRL 实机连接。请检查服务端的 NRL 配置。';
    else if (!networkPending && state?.network_enabled) {
      if (!state.online) issue = '软机头未连上 NRL。请检查 NRL 服务器和网络。';
      else if (state.wake_result === 'no-handshake' || state.wake_result === 'no-display') {
        issue = '机身开机回显不完整。请确认机身盒子在线，再长按电源重试。';
      } else if (state.power === 'on' && (state.locked || !state.dial_ready)) {
        const fixes = [];
        if (state.locked) fixes.push('面板已锁定，请长按 MENU 解锁。');
        if (!state.dial_ready) fixes.push('调谐旋钮未同步。请在网页长按电源关机，等屏幕熄灭后再长按开机。');
        issue = fixes.join(' ');
      }
    }
    const warning = issue || operationError || pttBlocked;
    const text = warning || message;
    if (notice.textContent !== text) notice.textContent = text;
    notice.classList.toggle('notice-warning', !!warning);
  }
  const controls = $('.controls-bar');
  controls.setAttribute('aria-label', '实机控制');
  const receive = mountReceiveAudio(controls, debug + 'audio', { compact: true, followRadio: true });
  const liveBadge = $('.mock-badge');
  const networkButton = document.createElement('button');
  networkButton.type = 'button';
  networkButton.className = 'network-button';
  networkButton.textContent = '联网';
  networkButton.disabled = true;
  $('.debug-link').before(networkButton);
  let networkPending = false;
  const displayCache = [null, null];
  let menuActive = false;
  let fastPollUntil = 0;
  let pttPollUntil = 0;
  let refreshTimer;
  let previousFrequencies = [];
  let receiveMeters = null;
  const pending = [];
  const angles = [0, 0];
  const knobPositions = Object.fromEntries(Object.values(knobScales).flatMap(scale =>
    sideName.map(side => [`${scale.field}-${side}`, scale.values[scale.defaultLevel - 1]])));
  let state = null;
  watchPanelActivity(() => state, debug + 'live/action');
  let muted = false;
  let running = false;
  let closed = false;

  document.title = 'IC-2730E · 实机面板';
  $('.mic-settings').hidden = true;
  for (const button of document.querySelectorAll('[data-mic]')) {
    button.disabled = !supportedMic.has(button.dataset.mic);
  }
  const transmit = mountPtt({
    buttons: [$('#ptt'), $('#micPtt')], send: (action, value, audio) =>
      command(action, value, audio, debug + 'live/action'),
    worklet: debug + 'mic-worklet.js', notify: warn, onLevel: receive?.setTransmitLevel, spaceShortcut: true,
    onActivity: () => {
      pttPollUntil = performance.now() + 1800;
      if (refreshTimer !== undefined) {
        clearTimeout(refreshTimer);
        refresh();
      }
    },
    onBlocked: text => {
      pttBlocked = text;
      renderNotice();
    },
  });
  const networkDialog = document.createElement('dialog');
  networkDialog.innerHTML = `
    <form method="dialog">
      <h2></h2>
      <p></p>
      <div class="network-options">
        <button type="submit" value="cancel" autofocus>取消</button>
        <button type="submit" value="confirm">确定</button>
      </div>
    </form>`;
  document.body.append(networkDialog);

  function confirmNetwork(title, message, cancel, confirm) {
    networkDialog.querySelector('h2').textContent = title;
    networkDialog.querySelector('p').textContent = message;
    networkDialog.querySelector('[value=cancel]').textContent = cancel;
    networkDialog.querySelector('[value=confirm]').textContent = confirm;
    networkDialog.returnValue = 'cancel';
    networkDialog.showModal();
    return new Promise(resolve => networkDialog.addEventListener('close', () => {
      resolve(networkDialog.returnValue === 'confirm');
    }, { once: true }));
  }

  async function connectNetwork() {
    const endpoint = debug + 'live/action';
    try {
      await command('network', 'on', undefined, endpoint);
    } catch (error) {
      if (!error.confirmNetwork) throw error;
      if (!await confirmNetwork('硬机头联网检查', error.message, '先关硬机头', '仍然联网')) {
        show('软机头保持脱网。关闭硬机头后可再次点击联网。');
        return false;
      }
      await command('network', 'force-on', undefined, endpoint);
    }
    return true;
  }

  async function waitForRadio(predicate, timeout) {
    const deadline = performance.now() + timeout;
    while (!closed && performance.now() < deadline) {
      if (state?.online && predicate(state)) return state;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return null;
  }

  async function connectAndPowerOn() {
    if (!await confirmNetwork('联网并开机', '软机头已脱网。要联网并开启机身吗？', '取消', '联网并开机')) return;
    networkPending = true;
    render();
    try {
      if (!await connectNetwork()) return;
      show('正在联网，等待读取机身电源状态…');
      const known = await waitForRadio(current => current.power === 'on' || current.power === 'off', 4500);
      if (closed) return;
      const current = known ?? (state?.online ? state : null);
      if (!current) throw new Error('尚未连上 NRL，机身开机请求未发送');
      if (current.power === 'on') {
        show('软机头已联网，机身已开机');
        return;
      }
      if (current.busy || current.tx || current.tx_releasing) throw new Error('软机头已联网，机身正在操作，请稍后再开机');
      await command('power-on-levels', { ...knobPositions }, undefined, debug + 'live/action');
      show('已联网，等待机身开机回显…');
      const result = await waitForRadio(radio => radio.power === 'on' || ['no-handshake', 'no-display'].includes(radio.wake_result), 15000);
      if (closed) return;
      show(result?.power === 'on' ? '软机头已联网，机身已开机' : '软机头已联网，未收到机身开机回显');
    } catch (error) {
      warn(error.message);
    } finally {
      networkPending = false;
      render();
    }
  }

  networkButton.addEventListener('click', async () => {
    if (networkPending || networkDialog.open || !state) return;
    const enable = !state.network_enabled;
    const power = state.power;
    if (!enable) {
      if (power !== 'on' && power !== 'off') {
        show('机身电源状态未同步，软机头保持联网');
        return;
      }
      if (power === 'on' && !await confirmNetwork('关机后脱网',
        '机身仍开着。确认后先关机，收到关机回显后软机头才会脱网。', '取消', '关机并脱网')) return;
    }
    networkPending = true;
    render();
    try {
      const endpoint = debug + 'live/action';
      if (!enable) {
        pending.length = 0;
        transmit.setState(null);
        if (power === 'on') show('正在关机，等待机身回显…');
        await command('network', power === 'on' ? 'shutdown-and-off' : 'off-if-powered-off', undefined, endpoint);
        state = null;
        show('机身已关机，软机头已脱网');
        return;
      }
      if (await connectNetwork()) show('正在连接软机头');
    } catch (error) {
      warn(error.message);
    } finally {
      networkPending = false;
      render();
    }
  });
  show('正在读取软机头状态…');

  function mainSide() {
    const index = state?.flags?.findIndex(flags => flags.includes('MAIN')) ?? -1;
    return index < 0 ? null : index;
  }

  function render() {
    renderNotice();
    const online = !!state?.online;
    const on = state?.power === 'on';
    const networkEnabled = !!state?.network_enabled;
    networkButton.dataset.actionTone = networkEnabled ? 'disconnect' : 'connect';
    networkButton.textContent = networkPending ? '切换中…' : networkEnabled ? '脱网' : '联网';
    networkButton.disabled = networkPending || !state || state.live_available === false;
    receive?.setRadioReady(!networkPending && online && on);
    const main = mainSide();
    const lcd = displayRows(state?.lcd || []);
    menuActive = online && on && menuIsActive(lcd, menuActive);
    window.showMenuSoftKeys(menuActive);
    const flags = state?.flags || [];
    const tx = flags.some(values => values.includes('TX'));
    document.body.classList.toggle('power-off', !online || state.power === 'off');
    $('#powerLamp').classList.toggle('on', on);
    $('#radio').classList.toggle('tx', tx);
    $('#micPowerLed').classList.toggle('lit', on);
    $('#micTxLed').classList.toggle('lit', tx);
    $('#lockIcon').style.opacity = on && state.locked ? 1 : 0;
    $('#status-main').textContent = main === null ? '主段待同步' : `${main ? '右' : '左'}段 MAIN`;
    const frequency = main === null ? null : parseDisplayText(lcd[main] || '').fullFrequency;
    $('#status-freq').textContent = frequency ? `${frequency} MHz` : '—';
    const phases = { handshake: '等待开机握手', pressing: '开机长按', waiting: '等待机身回显' };
    $('#status-mode').textContent = state && !networkEnabled ? '已脱网' : !online ? '连接中或离线' :
      phases[state.wake_phase] || (on ? '机身开机' : state.power === 'off' ? '机身关机' : '待同步');
    liveBadge.textContent = state && !networkEnabled ? `${state.station || '软机头'} · 已脱网` :
      online ? `实机连接 · ${state.station || '软机头'}` : '实机连接 · 未同步';
    for (let i = 0; i < 2; i++) {
      const raw = lcd[i] || '';
      const labels = (flags[i] || []).filter(label => screenFlags.has(label));
      const level = receiveMeters?.values[i] ?? null;
      const meterBytes = state?.meter_bytes?.[i];
      const lcdMuted = on && (muted || (tx && !labels.includes('TX')));
      const signature = JSON.stringify([raw, labels, level, meterBytes?.[1] & 0x40, lcdMuted]);
      if (signature !== displayCache[i]) {
        const band = $(`#band${i}`);
        band.innerHTML = drawBand(raw, labels, level, meterBytes, lcdMuted);
        band.classList.toggle('is-main', main === i);
        displayCache[i] = signature;
      }
      const dial = $(`[data-knob="dial"][data-band="${i}"]`);
      dial.setAttribute('aria-valuetext', parseDisplayText(raw).fullFrequency || '未同步');
      for (const [kind, {field, count: maximum, travel}] of Object.entries(knobScales)) {
        const knob = $(`[data-knob="${kind}"][data-band="${i}"]`);
        const level = knobLevel(kind, knobPositions[`${field}-${sideName[i]}`]);
        knob.setAttribute('aria-valuemin', '1');
        knob.setAttribute('aria-valuemax', String(maximum));
        knob.setAttribute('aria-valuenow', String(level));
        knob.setAttribute('aria-valuetext', `${level} / ${maximum}`);
        knob.title = `${level} / ${maximum} · 左半减，右半加`;
        knob.style.setProperty('--angle', `${(level - 1) * travel / (maximum - 1) - travel / 2}deg`);
      }
    }
  }

  async function refresh() {
    refreshTimer = undefined;
    if (closed) return;
    const started = performance.now();
    try {
      const response = await fetch(debug + 'live/state', {
        headers: {'X-Softhead-Audio': '1'}, signal: AbortSignal.timeout(1100), cache: 'no-store',
      });
      if (response.status === 401) {
        closed = true;
        loginExpired = true;
      }
      if (!response.ok) throw new Error('连接失败');
      const previous = state;
      state = await response.json();
      if (state.live_available === false) {
        closed = true;
        show('尚未配置 NRL 实机连接，可返回仿真页使用');
      }
      if (!state.network_enabled && (previous === null || previous.network_enabled)) {
        show(state.offline_reason === 'power-off-idle' ?
          '机身关机且超过闲置时限，软机头已自动脱网' : '软机头已脱网');
      }
      const frequencies = (state.lcd || []).map(raw => parseDisplayText(raw).fullFrequency);
      receiveMeters = pairReceiveMeters(state, frequencies, receiveMeters, performance.now());
      if (state.online && state.power === 'on' && frequencies.some((frequency, side) =>
        frequency && previousFrequencies[side] && frequency !== previousFrequencies[side])) {
        fastPollUntil = Math.max(fastPollUntil, performance.now() + scanActivityMs);
      }
      previousFrequencies = frequencies;

    } catch {
      state = null;
      fastPollUntil = 0;
      previousFrequencies = [];
      receiveMeters = null;
      pending.length = 0;
    }
    hasPolled = true;
    transmit.setState(networkPending ? null : state);
    render();
    const now = performance.now();
    const fast = !document.hidden && state?.online && state.power === 'on' &&
      (now < Math.max(fastPollUntil, pttPollUntil) || state.tx || state.tx_releasing || !!receiveMeters?.until);
    if (!closed) refreshTimer = setTimeout(refresh, fast ? Math.max(12, scanPollMs - (now - started)) : idlePollMs);
  }

  function ready() {
    if (!networkPending && state?.online && !state.busy && !state.tx && !state.tx_releasing && state.power === 'on') return true;
    warn('机身暂时无法操作。请确认已联网、已开机，并等待当前操作完成。');
    return false;
  }

  async function send(action, value) {
    try {
      await command(action, value, undefined, debug + 'live/action');
      operationError = '';
      renderNotice();
      return true;
    } catch (error) {
      warn(error.message || '操作未送达，请检查连接后重试');
      return false;
    }
  }

  function canStageLevels(kind) {
    return kind in knobScales && !networkPending && !powerPending && !state?.busy &&
      (!state?.network_enabled || state.power === 'off');
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (pending.length && !closed) {
        const { kind, band, delta, time, key } = pending.shift();
        if (performance.now() - time > (kind === 'mic' ? 1400 : 500)) continue;
        if (kind === 'mic' && state?.online && state.busy && !state.wake_phase && !state.tx) {
          pending.unshift({ kind, key, time });
          await new Promise(resolve => setTimeout(resolve, 50));
          continue;
        }
        const staging = canStageLevels(kind);
        if (!staging && !ready()) continue;
        if (kind === 'mic') {
          if (await send('mic', key)) await new Promise(resolve => setTimeout(resolve, 175));
          continue;
        }
        const side = sideName[band];
        if (kind === 'dial') {
          if (state.locked) { renderNotice(); continue; }
          if (!state.dial_ready) { renderNotice(); continue; }
          if (await send('dial', `${side}-${delta > 0 ? 'up' : 'down'}`)) {
            angles[band] += delta * 12;
            $(`[data-knob="dial"][data-band="${band}"]`).style.setProperty('--angle', `${angles[band]}deg`);
          }
        } else {
          const {field, count} = knobScales[kind];
          const action = `${field}-${side}`;
          const current = knobPositions[action];
          const next = stepKnob(kind, current, delta);
          if (next !== current && (staging || await send(action, next))) {
            knobPositions[action] = next;
            const description = `${band ? '右' : '左'}段${kind === 'sql' ? '静噪' : '音量'} ${knobLevel(kind, next)}/${count}`;
            show(staging ? `${description}，开机时应用` : description);
            render();
          }
        }
      }
    } finally {
      running = false;
    }
  }

  let powerPending = false;
  window.realPanel = {
    async key(key, band, held) {
      if (networkPending || networkDialog.open) return;
      if (key === 'power') {
        if (!held) {
          if (state?.power === 'on') { muted = receive?.toggleMute() ?? false; render(); }
          return;
        }
        if (state?.network_enabled === false) {
          await connectAndPowerOn();
          return;
        }
        if (!state?.online || state.busy || state.tx || state.tx_releasing || powerPending) return;
        powerPending = true;
        pending.length = 0;
        try {
          const sent = state.power === 'on' ? await send('power', 'off') : await send('power-on-levels', { ...knobPositions });
          if (sent) {
            show('电源请求已送出，等待机身回显');
          }
        } finally { powerPending = false; }
        return;
      }
      if (!panelKeys.includes(key) || !ready()) return;
      const value = ['main', 'vfo', 'mr'].includes(key) ? `${sideName[band]}-${key}` : key;
      pending.length = 0;
      if (held && key === 'vfo') fastPollUntil = performance.now() + 4000;
      if (await send(held ? 'key-hold' : 'key', value)) show('按键已送出，等待机身回显');
    },
    turn(kind, band, delta, repeat = false) {
      if (repeat && (running || pending.length)) return;
      if (powerPending || (!canStageLevels(kind) && !ready()) || pending.length >= 6) return;
      pending.push({ kind, band, delta, time: performance.now() });
      drain();
    },
    mic(key, held) {
      if (networkPending || !supportedMic.has(key)) return;
      if (key === 'home') {
        if (!held) { show('HOME 短按键码待确认'); return; }
        const main = mainSide();
        if (main !== null) return this.key('mr', main, true);
        show('等待 MAIN 回显');
        return;
      }
      if (key === 'vfo' && held) return this.key('menu', 0, true);
      if (!state?.online || state.power !== 'on' || state.tx || state.tx_releasing || pending.length >= 6) return;
      pending.push({ kind: 'mic', key, time: performance.now() });
      drain();
    },
  };
  window.addEventListener('pagehide', () => { closed = true; pending.length = 0; }, { once: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pending.length = 0; });
  render();
  document.body.dataset.panelReady = '1';
  refresh();
}
