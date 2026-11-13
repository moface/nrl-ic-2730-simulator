import { HeadCommands, HostDisplay } from './head-protocol.mjs';

const connectionLink = document.querySelector('#panelConnection');
if (window.panelConnectionAvailable && connectionLink) {
  connectionLink.hidden = window.panelIsLive;
  if (window.panelIsLive) {
    import('./debug/panel-live.mjs')
      .then(module => module.mountRealPanel())
      .catch(() => { document.querySelector('#notice').textContent = '实机控制模块加载失败，请刷新页面。'; });
  }
}
if (!window.panelIsLive && new URLSearchParams(location.search).get('protocol') === '1') mountPreview();

function mountPreview() {
  const commands = new HeadCommands();
  commands.seedDials(0, 0);
  const pane = document.createElement('section');
  pane.className = 'protocol-preview';
  pane.innerHTML = `
    <h2>报文预览</h2>
    <p>离线。旋钮计数从 0 开始；操作上方机头可查看生成的报文。</p>
    <p id="protocol-status" role="status">等待面板操作</p>
    <ol id="protocol-log" aria-label="生成的报文"></ol>
    <h3>机身显示回放</h3>
    <label>选择采集目录中的 state-replay.jsonl <input type="file" accept=".jsonl"></label>
    <p id="protocol-replay-status" role="status">等待导入</p>
    <label>回放位置 <input type="range" min="0" max="0" value="0" disabled></label>
    <output id="protocol-cells">??????????　??????????</output>
    <p>开关机使用盒子自定义控制，接收音频通过本机监听入口播放。PTT 只生成预览报文。</p>
  `;
  document.body.append(pane);
  const log = pane.querySelector('#protocol-log');
  const status = pane.querySelector('#protocol-status');
  const side = band => band === 0 ? 'left' : 'right';

  function show(records) {
    for (const record of records.slice().reverse()) {
      const item = document.createElement('li');
      item.textContent = `+${record.atMs} ms　Type ${record.type}　Status ${record.status.toString(16).padStart(2, '0')}　${record.payload.toUpperCase() || '空负载'}`;
      log.prepend(item);
    }
    while (log.children.length > 16) log.lastChild.remove();
    if (records.length) status.textContent = '已生成报文预览';
  }

  window.headProtocolPreview = {
    key(key, band, held) {
      if (key === 'power') {
        show(commands.ptt(false));
        status.textContent = '电源键当前只改变模拟器状态，盒子电源报文待确认';
        return;
      }
      show(commands.key(key, side(band), held));
    },
    dial(band, direction) {
      show(commands.dial(side(band), direction));
    },
    ptt(pressed) {
      show(commands.ptt(pressed));
    },
  };

  const file = pane.querySelector('input[type=file]');
  const range = pane.querySelector('input[type=range]');
  const cells = pane.querySelector('output');
  const replayStatus = pane.querySelector('#protocol-replay-status');
  let timeline = [];
  let revision = 0;
  function renderReplay() {
    const entry = timeline[Number(range.value)];
    if (!entry) return;
    cells.textContent = entry.bands.map(band => band.raw).join('　');
    replayStatus.textContent = `采集第 ${entry.seconds.toFixed(3)} 秒 · ${Number(range.value) + 1}/${timeline.length}`;
  }
  range.addEventListener('input', renderReplay);
  file.addEventListener('change', async () => {
    const selected = file.files[0];
    const current = ++revision;
    range.disabled = true;
    timeline = [];
    cells.textContent = '??????????　??????????';
    if (!selected) return;
    replayStatus.textContent = '读取回放文件';
    try {
      const content = await selected.text();
      if (current !== revision) return;
      const display = new HostDisplay();
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (typeof event.device !== 'string' || !event.device.endsWith('-0') ||
            typeof event.payload_hex !== 'string' || !Number.isFinite(event.seconds)) continue;
        if (!display.ingest(event.payload_hex)) continue;
        const bands = display.bands;
        if (timeline.at(-1)?.bands.every((band, i) => band.raw === bands[i].raw)) continue;
        timeline.push({ seconds: event.seconds, bands });
      }
      if (!timeline.length) throw new Error('没有可回放的机身显示');
      range.max = timeline.length - 1;
      range.value = 0;
      range.disabled = false;
      renderReplay();
    } catch {
      replayStatus.textContent = '无法读取机身回显，请选择有效的 state-replay.jsonl';
    }
  });
}
