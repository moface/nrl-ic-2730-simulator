const $=s=>document.querySelector(s);const $$=s=>[...document.querySelectorAll(s)];
const defaults=()=>({on:true,main:0,muted:false,locked:false,tx:false,rx:false,monitor:false,micEntry:null,light:3,beep:true,menu:null,edit:false,bluetooth:false,vox:false,bands:[{freq:145500,vol:5,sql:15,power:2,mem:false,ch:1,mhz:false,tone:0,duplex:0,step:5,mode:'FM',call:null,priority:0,scan:false},{freq:433500,vol:5,sql:15,power:2,mem:false,ch:2,mhz:false,tone:0,duplex:0,step:5,mode:'FM',call:null,priority:0,scan:false}]});
let state=defaults(),rotations={},scanTimer;let audio;const callFrequencies=[145500,433500];const memories=[145500,145000,433500,438500,439750,144800,435000,145700];const skippedChannels=new Set();const toneModes=['OFF','TONE','TSQL','DTCS','TSQL-R','DTCS-R','TSQL BELL','DTCS BELL','DTC.OFF','TON.DTC','DTC.TSQ','TON.TSQ'];const modes=['FM','FM-N','AM','AM-N'];const tuningSteps=[5,6.25,10,12.5,15,20,25,30,50];const menus=['TONE','OFFSET','R TONE','C TONE','CODE','TS','LIGHT','MODE','PRIO','SKIP'];let menuValues=['OFF','0.600','88.5','88.5','023','5.0','3','FM','OFF','OFF'];
const segments={0:'abcedf',1:'bc',2:'abged',3:'abgcd',4:'fgbc',5:'afgcd',6:'afgecd',7:'abc',8:'abcdefg',9:'abfgcd',C:'adef',A:'abcefg',B:'cdefg',D:'bcdeg',E:'adefg',F:'aefg','-':'g',' ':''};const polygons={a:'9,2 35,2 40,7 35,12 9,12 4,7',b:'37,14 42,9 42,38 37,43 32,38 32,19',c:'37,47 42,42 42,72 37,77 32,72 32,52',d:'9,74 35,74 40,79 35,84 9,84 4,79',e:'2,47 7,42 12,47 12,72 7,77 2,72',f:'2,14 7,9 12,14 12,38 7,43 2,38',g:'9,38 35,38 40,43 35,48 9,48 4,43'};
// Fixed LCD coordinates follow the controller-display diagram in the IC-2730 manual.
// Both bands use the same 520 × 280 coordinate grid, so labels cannot drift with fonts.
function lcdNumber(chars,x,y,width,height){let parts=[],offset=0;for(const c of chars){if(c==='.'){parts.push(`<rect x="${offset}" y="77" width="6" height="7" rx="1"/>`);offset+=10;continue}parts.push(`<g transform="translate(${offset},0)">${Object.entries(polygons).map(([k,p])=>`<polygon points="${p}" opacity="${segments[c]?.includes(k)?1:.018}"/>`).join('')}</g>`);offset+=49}return `<g transform="translate(${x},${y}) scale(${width/offset},${height/86})">${parts.join('')}</g>`}
// Fourteen independently drawn LCD segments; no font dependency for menu glyphs.
const alphaPolygons={a:'9,2 35,2 39,6 35,10 9,10 5,6',b:'37,12 41,8 43,12 43,37 39,41 35,37 35,16',c:'39,46 43,42 43,73 39,77 35,73 35,50',d:'9,76 35,76 39,80 35,84 9,84 5,80',e:'3,47 7,43 11,47 11,72 7,76 3,72',f:'3,13 7,9 11,13 11,37 7,41 3,37',g1:'10,39 19,39 22,43 19,47 10,47 6,43',g2:'25,39 34,39 38,43 34,47 25,47 22,43',h:'12,13 17,17 22,33 20,38 17,34 12,19',i:'20,12 24,12 24,34 22,38 20,34',j:'32,13 32,19 27,34 24,38 22,33 27,17',k:'17,52 20,48 22,53 17,69 12,74 12,68',l:'20,52 22,48 24,52 24,74 20,74',m:'24,48 27,52 32,68 32,74 27,69 22,53'};
const alphaGlyphs={A:'a b c e f g1 g2',B:'a b c d g2 i l',C:'a d e f',D:'a b c d i l',E:'a d e f g1 g2',F:'a e f g1 g2',G:'a c d e f g2',H:'b c e f g1 g2',I:'a d i l',J:'b c d e',K:'e f j m',L:'d e f',M:'b c e f h j',N:'b c e f h m',O:'a b c d e f',P:'a b e f g1 g2',Q:'a b c d e f m',R:'a b e f g1 g2 m',S:'a c d f g1 g2',T:'a i l',U:'b c d e f',V:'e f j k',W:'b c e f k m',X:'h j k m',Y:'h j l',Z:'a d j k','0':'a b c d e f','1':'b c','2':'a b d e g1 g2','3':'a b c d g1 g2','4':'b c f g1 g2','5':'a c d f g1 g2','6':'a c d e f g1 g2','7':'a b c','8':'a b c d e f g1 g2','9':'a b c d f g1 g2','-':'g1 g2','+':'g1 g2 i l','/':'j k',' ':''};
function lcdFrequency(text) {
  const parts = [];
  let cell = 0;
  let decimalShown = false;
  let visible = '';
  for (const character of String(text).toUpperCase()) {
    if (character === '.') {
      if (!decimalShown && cell > 0 && cell < 6) {
        parts.push(`<rect x="${cell * 49 - 4}" y="77" width="5" height="7" rx=".8"/>`);
        decimalShown = true;
        visible += '.';
      }
      continue;
    }
    if (cell === 6) break;
    parts.push(lcdCharacter(character, cell++));
    visible += character;
  }
  for (; cell < 6; cell++) parts.push(lcdCharacter(' ', cell));
  const label = visible.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  return `<foreignObject x="0" y="54" width="475" height="124">
    <svg class="menu-segment-strip" viewBox="0 0 294 87" preserveAspectRatio="none" role="img"
      aria-label="${label}">${parts.join('')}</svg>
  </foreignObject>`;
}

function lcdCharacter(character, cell) {
  const active = (alphaGlyphs[character] || '').split(' ');
  const shapes = Object.entries(alphaPolygons).map(([name, points]) =>
    `<polygon points="${points}" opacity="${active.includes(name) ? 1 : .012}"/>`
  ).join('');
  return `<g transform="translate(${cell * 49},0)">${shapes}</g>`;
}

function lcdTextMark(text, x, y, size, on, width) {
  const fitted = width ? `textLength="${width}" lengthAdjust="spacingAndGlyphs"` : '';
  return `<text data-lcd-mark="${text}" x="${x}" y="${y}" font-size="${size}" ${fitted}
    opacity="${on ? 1 : .018}">${text}</text>`;
}

function lcdBadge(text, x, y, width, height, on) {
  return `<g data-lcd-mark="${text}" opacity="${on ? 1 : .018}">
    <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="6"/>
    <text x="${x + width / 2}" y="${y + height - 5}" text-anchor="middle"
      font-size="${height - 2}" font-weight="700" fill="#eef2ee">${text}</text>
  </g>`;
}

const lcdBell = '<path d="M274 12q-7 0-7 10v5h14v-5q0-10-7-10m-3 19h6" fill="none" stroke="currentColor" stroke-width="3"/>';

function lcdFineMarks(fine) {
  return `
    ${lcdTextMark('75', 478, 113, 28, fine === 75, 37)}
    ${lcdTextMark('50', 478, 146, 28, fine === 50, 37)}
    ${lcdTextMark('25', 478, 179, 28, fine === 25, 37)}`;
}

function lcdBandMarks(labels, { blinkBusy = false } = {}) {
  const has = name => labels.includes(name);
  const duplex = has('DUP+') ? 'DUP+' : 'DUP−';
  return `
    ${lcdBadge('MAIN', 0, 4, 102, 32, has('MAIN'))}
    ${lcdBadge('TX', 113, 4, 70, 32, has('TX'))}
    ${lcdTextMark(duplex, 192, 29, 31, has(duplex), 78)}
    ${lcdTextMark('TSQL', 285, 29, 31, has('TSQL') || has('TSQL-R'), 84)}
    ${lcdTextMark('T', 285, 29, 31, has('T'))}
    ${lcdTextMark('DTCS', 383, 29, 31, has('DTCS') || has('DTCS-R'), 85)}
    ${lcdTextMark('−R', 472, 29, 29, has('TSQL-R') || has('DTCS-R'), 45)}
    <g class="${blinkBusy ? 'lcd-blink' : ''}">${lcdTextMark('BUSY', 0, 217, 30, has('BUSY'), 60)}</g>
    ${lcdTextMark('LOW', 72, 217, 30, has('LOW'), 55)}
    ${lcdTextMark('MID', 147, 217, 30, has('MID'), 47)}
    ${lcdTextMark('NAR', 203, 217, 30, has('NAR'), 49)}
    ${lcdTextMark('AM', 258, 217, 30, has('AM'), 38)}
    ${lcdBadge('MR', 301, 193, 56, 28, has('MR'))}
    <g data-lcd-badge="SKIP" opacity="${has('SKIP') ? 1 : .018}">
      <rect x="301" y="228" width="56" height="27" rx="4" fill="none" stroke="#222d30" stroke-width="2"/>
      ${lcdTextMark('SKIP', 303, 250, 26, true, 52)}
    </g>`;
}

function fullFrequency(freq){return (freq/1000).toFixed(5)}
function parseFrequency(text){const mhz=Number(text),hz=Math.round(mhz*1e6);if(!Number.isFinite(mhz)||Math.abs(mhz*1e6-hz)>0.0001||hz%250!==0||!((hz>=118e6&&hz<=174e6)||(hz>=375e6&&hz<=550e6)))return null;return hz/1000}
function toneDisplay(b,tx){let mode=toneModes[b.tone]||'OFF';if(mode==='DTC.OFF')mode=tx?'DTCS':'OFF';if(mode==='TON.DTC')mode=tx?'TONE':'DTCS';if(mode==='DTC.TSQ')mode=tx?'DTCS':'TSQL';if(mode==='TON.TSQ')mode=tx?'TONE':'TSQL';return {tone:mode==='TONE',sql:mode.startsWith('TSQL'),dtcs:mode.startsWith('DTCS'),reverse:mode.endsWith('-R'),bell:mode.endsWith('BELL')}}
function syncMenuValues(){const b=state.bands[state.main];menuValues[0]=toneModes[b.tone];menuValues[5]=String(b.step);menuValues[6]=String(state.light+1);menuValues[7]=b.mode;menuValues[8]=['OFF','ON','BELL'][b.priority];menuValues[9]=b.mem?(skippedChannels.has(b.ch)?'SKIP':'OFF'):'MR ONLY'}
function lcdBand(b, i) {
  const main = state.main === i;
  const tx = state.tx && main;
  const rx = (state.rx || state.monitor || b.sql === 1) && !state.tx;
  const tone = toneDisplay(b, tx);
  const muted = state.muted || (state.tx && !main);
  const entry = state.micEntry?.band === i ? state.micEntry.display : null;
  const frequency = (Math.floor(b.freq) / 1000).toFixed(3);
  const fine = muted || entry !== null ? 0 : Math.round((b.freq - Math.floor(b.freq)) * 100);
  const text = muted ? 'MUTE' : entry ?? frequency;
  const channel = b.call != null ? ' C' + b.call : b.mem ? String(b.ch).padStart(3, '0') : '   ';
  const labels = [
    main && 'MAIN', tx && 'TX', rx && 'BUSY',
    b.duplex === 1 && 'DUP−', b.duplex === 2 && 'DUP+',
    tone.sql && (tone.reverse ? 'TSQL-R' : 'TSQL'), tone.tone && 'T',
    tone.dtcs && (tone.reverse ? 'DTCS-R' : 'DTCS'),
    b.power === 0 && 'LOW', b.power === 1 && 'MID',
    b.mode.endsWith('-N') && 'NAR', b.mode.startsWith('AM') && 'AM', b.mem && 'MR', b.mem && skippedChannels.has(b.ch) && 'SKIP',
  ];
  const meter = Array.from({length: 12}, (_, n) => {
    const lit = tx ? n < [4, 6, 12][b.power] : rx && n < 7 + i;
    return `<rect x="${n * 24}" y="228" width="21" height="24" opacity="${lit ? 1 : .018}"/>`;
  }).join('');
  const description = [muted ? 'MUTE' : `${fullFrequency(b.freq)} 兆赫`, main && '主段',
    tx ? '发射' : rx && '接收', b.call != null ? `呼叫信道 C${b.call}` : b.mem ? `存储信道 ${b.ch}` : 'VFO'];
  return `<svg class="lcd-drawing" viewBox="0 0 520 280" preserveAspectRatio="none" role="img"
      aria-label="${description.filter(Boolean).join('，')}">
    ${lcdBandMarks(labels, { blinkBusy: state.monitor })}
    ${tone.bell ? lcdBell : ''}
    ${lcdFrequency(text)}
    ${lcdFineMarks(fine)}
    ${meter}${lcdNumber(channel, 366, 198, 150, 60)}
    <g class="${b.priority === 2 ? 'lcd-blink' : ''}">${lcdTextMark('PRIO', 366, 279, 23, b.priority > 0, 63)}</g>
    ${i === 0 ? lcdTextMark('VOX', 445, 279, 23, state.bluetooth && state.vox, 65) : ''}
    ${state.bluetooth && i === 0 ? '<path d="M500 55l16 15-16 15V55l16-15v60l-16-15" fill="none" stroke="currentColor" stroke-width="3"/>' : ''}
    ${lcdTextMark('SCAN', 0, 276, 23, b.scan, 62)}
    </svg><div class="frequency" tabindex="0" data-edit="${i}" title="双击直接输入频率" role="button"
      aria-label="编辑${i ? '右' : '左'}段频率"></div>`;
}
function beep(hz=880,len=.035){if(!state.beep)return;try{audio??=new AudioContext();audio.resume();let o=audio.createOscillator(),g=audio.createGain();o.type='sine';o.frequency.value=hz;g.gain.setValueAtTime(.035,audio.currentTime);g.gain.exponentialRampToValueAtTime(.001,audio.currentTime+len);o.connect(g);g.connect(audio.destination);o.start();o.stop(audio.currentTime+len)}catch{}}
function note(message) {
  const notice = $('#notice');
  notice.textContent = message;
  notice.classList.remove('pulse');
  requestAnimationFrame(() => notice.classList.add('pulse'));
}
function render(){if(window.panelIsLive)return;document.body.classList.toggle('power-off',!state.on);$('#radio').classList.toggle('tx',state.tx);$('#radio').classList.toggle('muted',state.muted);$('#lcd').style.setProperty('--brightness',[.55,.75,.88,1][state.light]);for(let i=0;i<2;i++){let b=state.bands[i],el=$(`#band${i}`);el.classList.toggle('is-main',state.main===i);el.innerHTML=lcdBand(b,i);for(const kind of ['dial','vol','sql']){const k=$(`[data-knob="${kind}"][data-band="${i}"]`);if(k){let deg=kind==='dial'?(rotations[i]||0):(kind==='vol'?(b.vol-1)/9*270-135:(b.sql-1)/31*300-150);k.style.setProperty('--angle',deg+'deg');k.setAttribute('aria-valuenow',kind==='dial'?b.freq:b[kind]);}}}
syncMenuValues();$('#lcd').classList.toggle('locked',state.locked);$('#lockIcon').style.opacity=state.locked?1:0;$('#menuScreen').hidden=state.menu===null;$('#normalScreen').hidden=state.menu!==null;if(state.menu!==null){renderMenuFields(state.edit?menus[state.menu]:'MENU',state.edit?menuValues[state.menu]:menus[state.menu],state.edit&&menus[state.menu]==='TONE'&&toneDisplay(state.bands[state.main],false).bell);$('#menuScreen').classList.toggle('editing',state.edit)}showMenuSoftKeys(state.on&&state.menu!==null);$('#ptt').classList.toggle('pressed',state.tx);$('#ptt').setAttribute('aria-pressed',state.tx);$('#rx').setAttribute('aria-pressed',state.rx);$('#rx').classList.toggle('selected',state.rx);$('#status-main').textContent=(state.main===0?'左段':'右段')+' MAIN';$('#status-freq').textContent=fullFrequency(state.bands[state.main].freq)+' MHz';$('#status-mode').textContent=state.on?(state.tx?'模拟发射':(state.rx||state.monitor)?'模拟接收':'待机'):'已关机';$('#powerLamp').classList.toggle('on',state.on);$('#lockToggle').setAttribute('aria-pressed',state.locked);$('#lockToggle').textContent=state.locked?'解除锁定':'锁定面板';}
function renderMenuFields(name, value, bell) {
  const title = name.length < 6 ? name.padEnd(5) + '-' : name;
  const setting = value.replace(' BELL', '').replace('MR ONLY', 'MRONLY');
  $('#menuName').innerHTML = lcdBadge('MAIN', 0, 4, 102, 32, true) + (bell ? lcdBell : '') + lcdFrequency(title);
  $('#menuValue').innerHTML = lcdFrequency(setting);
}

function alignMenuSoftKeys(){const menu=$('#menuSoftKeys');if(menu.hidden)return;const r=menu.getBoundingClientRect();$$('[data-menu-key]').forEach(icon=>{const key=$('.function-keys [data-action="'+icon.dataset.menuKey+'"]');const b=key.getBoundingClientRect();icon.style.left=(b.left+b.width/2-r.left)+'px'})}
function showMenuSoftKeys(active) {
  const keys = $('#menuSoftKeys');
  if (keys.hidden === !active) return;
  keys.hidden = !active;
  if (active) alignMenuSoftKeys();
}
new ResizeObserver(alignMenuSoftKeys).observe($('#radio'));
function action(key,i=state.main,long=false){if(window.panelIsLive){window.realPanel?.key(key,i,long);return;}if(key==='power'){window.headProtocolPreview?.key(key,i,long);if(long){ptt(false);state.on=!state.on;state.menu=null;note(state.on?'电源开启':'电源关闭')}else if(state.on){state.muted=!state.muted;note(state.muted?'音频已静音':'音频静音解除')}render();beep(660);return}if(!state.on)return;if(state.locked&&key!=='menu'){note('面板已锁定，长按 MENU 解锁');return}window.headProtocolPreview?.key(key,i,long);let b=state.bands[i];beep(i?1046:880);if(key==='main'){state.main=i;note(long?'切换工作频段（模拟）':(i?'右':'左')+'段设为 MAIN');if(long)b.freq=b.freq<300000?433500:145500;}if(key==='vfo'){b.call=null;state.main=i;if(long){b.scan=!b.scan;note(b.scan?'开始模拟扫描':'停止扫描')}else{if(b.mem)b.mem=false;else b.mhz=!b.mhz;note(b.mhz?'1 MHz 调谐':'VFO 调谐')}}if(key==='mr'){b.call=null;state.main=i;b.mem=true;if(long)b.ch=1;b.freq=memories[(b.ch-1)%memories.length];note(long?'呼叫信道':'存储信道 '+b.ch)}if(key==='moni'){if(state.menu!==null){if(state.edit){state.edit=false;note('返回菜单项目')}else{state.menu=null;note('退出菜单')}}else if(long){b.duplex=(b.duplex+1)%3;note(['单工','负差频','正差频'][b.duplex])}else{state.monitor=!state.monitor;note(state.monitor?'监听开启（模拟）':'监听关闭')}}if(key==='low'){if(state.menu!==null){state.edit=true;note('进入菜单数值设置')}else if(long){$('#dtmfDialog').showModal()}else{b.power=(b.power+1)%3;note(['低功率 5 W','中功率 15 W','高功率 50 W'][b.power])}}if(key==='mw'){if(state.menu!==null){state.edit=!state.edit;note(state.edit?'调整菜单数值':'菜单数值已保存')}else{b.call=null;memories[(b.ch-1)%memories.length]=b.freq;b.mem=true;note('已保存至模拟存储信道 '+b.ch)}}if(key==='menu'){if(long){state.locked=!state.locked;state.menu=null;note(state.locked?'面板锁定':'面板解锁')}else if(state.menu===null){state.menu=0;note('进入菜单')}else{state.menu=null;state.edit=false;note('退出菜单')}}render()}
function turn(kind,i,delta,repeat=false){if(window.panelIsLive){window.realPanel?.turn(kind,i,delta,repeat);return;}if(kind==='dial'&&(!state.on||state.locked))return;if(kind==='dial'&&window.headProtocolPreview)window.headProtocolPreview.dial(i,delta);if(kind==='dial'&&state.micEntry)state.micEntry=null;state.main=i;let b=state.bands[i];if(kind==='dial'){rotations[i]=(rotations[i]||0)+delta*12;if(state.menu!==null){if(state.edit){if(menus[state.menu]==='LIGHT'){state.light=(state.light+delta+4)%4}else if(menus[state.menu]==='TONE'){b.tone=(b.tone+delta+toneModes.length)%toneModes.length}else if(menus[state.menu]==='TS'){const steps=tuningSteps;b.step=steps[(steps.indexOf(b.step)+delta+steps.length)%steps.length];menuValues[state.menu]=String(b.step)}else if(menus[state.menu]==='MODE'){b.mode=modes[(modes.indexOf(b.mode)+delta+modes.length)%modes.length]}else if(menus[state.menu]==='PRIO'){b.priority=(b.priority+delta+3)%3}else if(menus[state.menu]==='SKIP'){if(b.mem){if(skippedChannels.has(b.ch))skippedChannels.delete(b.ch);else skippedChannels.add(b.ch)}else note('请先进入 MR 模式选择存储信道')}else menuValues[state.menu]=(Number(menuValues[state.menu])+delta*.1).toFixed(1)}else state.menu=(state.menu+delta+menus.length)%menus.length}else if(b.call!=null){b.call=Math.max(0,Math.min(1,b.call+delta));b.freq=callFrequencies[b.call]}else if(b.mem){b.ch=((b.ch-1+delta+memories.length)%memories.length)+1;b.freq=memories[b.ch-1]}else{b.freq=Math.round((b.freq+delta*(b.mhz?1000:b.step))*100)/100;if(b.freq>174000&&b.freq<375000)b.freq=delta>0?375000:174000;b.freq=Math.max(118000,Math.min(550000,b.freq))}note('调谐 '+fullFrequency(b.freq)+' MHz')}else{b[kind]=Math.max(1,Math.min(kind==='sql'?32:10,b[kind]+delta));note((i?'右段':'左段')+(kind==='vol'?'音量':'静噪')+' '+b[kind]+'/'+(kind==='sql'?32:10))}render()}
let pttTimer;function ptt(on){if(window.panelIsLive)return;if(on&&(!state.on||state.menu!==null||state.micEntry?.kind==='freq'))return;if(state.tx===on)return;if(window.headProtocolPreview)window.headProtocolPreview.ptt(on);state.tx=on;clearTimeout(pttTimer);if(on)pttTimer=setTimeout(()=>ptt(false),30000);note(on?'模拟 PTT 按下 · 没有射频发射':'模拟 PTT 释放');render()}
$$('[data-action]').forEach(button => {
  const isPower = button.dataset.action === 'power';
  const band = () => Number(button.dataset.band ?? state.main);
  let timer;
  let held = false;
  let pointerId = null;

  function clearPress() {
    clearTimeout(timer);
    pointerId = null;
    if (isPower) button.classList.remove('is-pressed');
  }

  button.addEventListener('pointerdown', event => {
    if (event.button !== 0 || pointerId !== null) return;
    held = false;
    button.setPointerCapture(event.pointerId);
    pointerId = event.pointerId;
    if (isPower) button.classList.add('is-pressed');
    timer = setTimeout(() => {
      held = true;
      action(button.dataset.action, band(), true);
    }, isPower ? 1000 : window.panelIsLive ? 950 : 700);
  });
  button.addEventListener('pointerup', event => {
    if (event.pointerId !== pointerId) return;
    clearPress();
    if (!held) action(button.dataset.action, band());
  });
  for (const type of ['pointercancel', 'lostpointercapture', 'blur']) {
    button.addEventListener(type, clearPress);
  }
  button.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (isPower) button.classList.add('is-pressed');
    if (!window.panelIsLive || !event.repeat) action(button.dataset.action, band(), event.shiftKey);
  });
  if (isPower) {
    button.addEventListener('keyup', event => {
      if (event.key === 'Enter' || event.key === ' ') clearPress();
    });
    window.addEventListener('blur', clearPress);
  }
});
const knobStops = new Set();
function stopKnobRepeats() {
  for (const stop of knobStops) stop();
}
window.addEventListener('blur', stopKnobRepeats);
window.addEventListener('pagehide', stopKnobRepeats);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopKnobRepeats();
});

$$('[data-knob]').forEach(knob => {
  const rotate = (direction, repeat = false) =>
    turn(knob.dataset.knob, Number(knob.dataset.band), direction, repeat);
  const face = document.createElement('span');
  face.className = 'knob-face';
  face.append(...knob.childNodes);
  knob.append(face);
  knob.title = '左半减一格，右半加一格；按住连续调节';

  let active = null;
  let timer;
  function stop(event) {
    if (!active || (event && event.pointerId !== active.id)) return;
    clearTimeout(timer);
    active = null;
    knobStops.delete(stop);
  }

  for (const [side, glyph, direction] of [['left', '−', -1], ['right', '＋', 1]]) {
    const half = document.createElement('span');
    half.className = `knob-half knob-half-${side}`;
    half.setAttribute('aria-hidden', 'true');
    half.textContent = glyph;
    half.addEventListener('pointerdown', event => {
      if (event.button !== 0 || active) return;
      event.preventDefault();
      knob.classList.add('pointer-focused');
      knob.focus({preventScroll:true});
      half.setPointerCapture(event.pointerId);
      active = {id:event.pointerId, x:event.clientX, y:event.clientY};
      knobStops.add(stop);
      rotate(direction);
      function repeat() {
        if (!active) return;
        rotate(direction, true);
        timer = setTimeout(repeat, 160);
      }
      timer = setTimeout(repeat, 420);
    });
    half.addEventListener('pointermove', event => {
      if (active?.id === event.pointerId && Math.hypot(event.clientX - active.x, event.clientY - active.y) > 8) stop(event);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) half.addEventListener(type, stop);
    knob.append(half);
  }

  knob.addEventListener('blur', () => {
    knob.classList.remove('pointer-focused');
    stop();
  });
  knob.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'].includes(event.key)) return;
    knob.classList.remove('pointer-focused');
    event.preventDefault();
    if (!event.repeat) rotate(['ArrowUp', 'ArrowRight'].includes(event.key) ? 1 : -1);
  });
});
$('#ptt').addEventListener('keydown',e=>{if((e.code==='Space'||e.key==='Enter')&&!e.repeat){e.preventDefault();ptt(true)}});$('#ptt').addEventListener('keyup',e=>{if(e.code==='Space'||e.key==='Enter'){e.preventDefault();ptt(false)}});$('#ptt').addEventListener('blur',()=>ptt(false));
$('#ptt').addEventListener('pointerdown',e=>{e.currentTarget.setPointerCapture(e.pointerId);ptt(true)});for(const e of ['pointerup','pointercancel','lostpointercapture'])$('#ptt').addEventListener(e,()=>ptt(false));document.addEventListener('keydown',e=>{if(e.code==='Space'&&!e.repeat&&!/INPUT|BUTTON|SELECT|TEXTAREA/.test(e.target.tagName)&&!document.querySelector('dialog[open]')){e.preventDefault();ptt(true)}if(e.key==='Escape'){ptt(false);state.menu=null;render()}});document.addEventListener('keyup',e=>{if(e.code==='Space')ptt(false)});window.addEventListener('blur',()=>ptt(false));document.addEventListener('visibilitychange',()=>{if(document.hidden)ptt(false)});
$('#rx').onclick=()=>{if(!state.on)return;state.rx=!state.rx;note(state.rx?'模拟双段来信':'模拟来信停止');render()};$('#light').onclick=()=>{state.light=(state.light+1)%4;note('背光等级 '+state.light);render()};$('#lockToggle').onclick=()=>action('menu',state.main,true);$('#guide').onclick=()=>$('#guideDialog').showModal();$('#reset').onclick=()=>{ptt(false);clearTimeout(pttTimer);skippedChannels.clear();memories.splice(0,memories.length,145500,145000,433500,438500,439750,144800,435000,145700);state=defaults();$('#sound').classList.add('selected');$('#sound').setAttribute('aria-pressed','true');menuValues=['OFF','0.600','88.5','88.5','023','5.0','3','FM','OFF','OFF'];rotations={};ptt(false);note('模拟状态已复位');render()};$('#sound').onclick=e=>{state.beep=!state.beep;e.currentTarget.classList.toggle('selected',state.beep);e.currentTarget.setAttribute('aria-pressed',state.beep);note(state.beep?'按键音开启':'按键音关闭');beep()};$$('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$('#lcd').addEventListener('dblclick',e=>{const el=e.target.closest('[data-edit]');if(!el||!state.on||state.locked||state.menu!==null)return;state.main=Number(el.dataset.edit);$('#frequencyInput').value=fullFrequency(state.bands[state.main].freq);$('#frequencyDialog').showModal();$('#frequencyInput').focus();$('#frequencyInput').select()});$('#frequencyForm').onsubmit=e=>{e.preventDefault();let n=parseFrequency($('#frequencyInput').value);if(n===null){$('#frequencyError').textContent='请输入 118–174 或 375–550 MHz 范围内、精度为 250 Hz 整数倍的频率';return}state.bands[state.main].freq=n;state.bands[state.main].mem=false;$('#frequencyError').textContent='';$('#frequencyDialog').close();note('频率设为 '+fullFrequency(n)+' MHz');render()};
$('#dtmfKeys').innerHTML='123A456B789C*0#D'.split('').map(c=>`<button type="button" data-tone="${c}">${c}</button>`).join('');$$('[data-tone]').forEach(b=>b.onclick=()=>{beep(1100,.1);$('#dtmfReadout').textContent=($('#dtmfReadout').textContent+b.dataset.tone).slice(-16);note('模拟 DTMF '+b.dataset.tone)});
function advanceScan(b){if(b.mem){const eligible=memories.map((_,i)=>i+1).filter(ch=>!skippedChannels.has(ch));if(!eligible.length){b.scan=false;note('没有可扫描的非跳过信道');return}let next=b.ch;do{next=next%memories.length+1}while(skippedChannels.has(next));b.ch=next;b.freq=memories[next-1]}else{b.freq=Math.round((b.freq+b.step)*100)/100;if(b.freq>174000&&b.freq<375000)b.freq=145000;if(b.freq>550000)b.freq=433000}}
setInterval(()=>{if(!state.on||state.tx||state.menu!==null)return;let changed=false;state.bands.forEach(b=>{if(b.scan){advanceScan(b);changed=true}});if(changed)render()},300);

render();
