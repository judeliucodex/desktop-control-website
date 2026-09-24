// PA Console client: WebSocket link, mic capture, hold-to-talk, Wi-Fi panel.
'use strict';

const $ = (id) => document.getElementById(id);
const els = {
  wsDot: $('wsDot'), wsLabel: $('wsLabel'), peerChip: $('peerChip'), peerLabel: $('peerLabel'),
  rttChip: $('rttChip'), rttLabel: $('rttLabel'),
  ptt: $('ptt'), pttHint: $('pttHint'), onair: $('onair'),
  meterFill: $('meterFill'), chimeToggle: $('chimeToggle'), micSelect: $('micSelect'),
  wifiSsid: $('wifiSsid'), wifiIp: $('wifiIp'), ipList: $('ipList'),
  wifiForm: $('wifiForm'), wifiSsidInput: $('wifiSsidInput'), wifiPassInput: $('wifiPassInput'),
  wifiBtn: $('wifiBtn'), wifiStatus: $('wifiStatus'),
};

// ------------------------------------------------------------------ state

let ws = null;
let wsReady = false;
let roleReady = false; // server accepted our operator role
let micReady = false;
let talking = false;
let replacing = false;
let pingTimer = null;
let reconnectDelay = 500;

// ------------------------------------------------------------------- audio

let audioCtx = null;
let workletNode = null;
let micStream = null;

async function ensureMic() {
  if (micReady) return true;
  try {
    const constraints = {
      audio: {
        deviceId: els.micSelect.value ? { exact: els.micSelect.value } : undefined,
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
      },
    };
    micStream = await navigator.mediaDevices.getUserMedia(constraints);

    // Prefer a context that runs natively at 24 kHz; the worklet decimates otherwise.
    let ctx;
    try {
      ctx = new AudioContext({ sampleRate: 24000 });
      if (ctx.sampleRate !== 24000) { await ctx.close(); ctx = null; }
    } catch { ctx = null; }
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume();

    await ctx.audioWorklet.addModule('/worklet.js');
    const src = ctx.createMediaStreamSource(micStream);
    workletNode = new AudioWorkletNode(ctx, 'ptt-capture', { numberOfOutputs: 1, outputChannelCount: [1] });
    workletNode.port.onmessage = (e) => {
      if (e.data.type !== 'chunk') return;
      setMeter(e.data.rms);
      if (talking && wsReady && roleReady && e.data.chunk) {
        ws.send(e.data.chunk); // Int16Array transferred from the worklet
      }
    };
    // Mute the monitor path: capture only, nothing should play out of the Mac.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    src.connect(workletNode);
    workletNode.connect(sink);
    sink.connect(ctx.destination);

    audioCtx = ctx;
    micReady = true;
    els.ptt.disabled = false;
    els.pttHint.textContent = 'hold space or press the button';
    await listMics();
    return true;
  } catch (err) {
    els.pttHint.textContent = 'mic blocked: ' + err.name;
    return false;
  }
}

async function listMics() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput');
    const current = els.micSelect.value;
    els.micSelect.innerHTML = '';
    for (const d of mics) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || 'Microphone';
      els.micSelect.appendChild(opt);
    }
    if ([...els.micSelect.options].some((o) => o.value === current)) els.micSelect.value = current;
  } catch { /* non-fatal */ }
}

els.micSelect.addEventListener('change', async () => {
  // Re-open the stream with the newly chosen device.
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micReady = false;
  if (workletNode) workletNode.port.onmessage = null;
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  talking = false;
  setTalkUi(false);
  await ensureMic();
});

// --------------------------------------------------------------------- PTT

async function startTalk() {
  if (talking || replacing) return;
  if (!wsReady || !roleReady) { flashHint('not connected'); return; }
  if (!(await ensureMic())) return;
  talking = true;
  ws.send(JSON.stringify({ type: 'talk_start' }));
  setTalkUi(true);
}

function stopTalk() {
  if (!talking) return;
  talking = false;
  setTalkUi(false);
  setMeter(0);
  if (wsReady && roleReady) ws.send(JSON.stringify({ type: 'talk_stop' }));
}

function setTalkUi(on) {
  els.ptt.classList.toggle('live', on);
  els.onair.hidden = !on;
}

let hintTimer = null;
function flashHint(msg) {
  els.pttHint.textContent = msg;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    els.pttHint.textContent = micReady ? 'hold space or press the button' : 'enable mic first';
  }, 1500);
}

els.ptt.addEventListener('pointerdown', (e) => { els.ptt.setPointerCapture(e.pointerId); startTalk(); });
els.ptt.addEventListener('pointerup', stopTalk);
els.ptt.addEventListener('pointercancel', stopTalk);

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat) return;
  if (e.target && ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(e.target.tagName)) return;
  e.preventDefault();
  startTalk();
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') stopTalk(); });
window.addEventListener('blur', stopTalk);

function setMeter(rms) {
  // Perceptual-ish scale so normal speech lights the meter usefully.
  const pct = Math.min(100, Math.round(Math.sqrt(rms) * 260));
  els.meterFill.style.width = pct + '%';
}

// -------------------------------------------------------------- websocket

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    wsReady = true;
    reconnectDelay = 500;
    setWsUi('yellow', 'handshake');
    ws.send(JSON.stringify({ type: 'hello', role: 'operator', name: 'Mac Console' }));
    pingTimer = setInterval(() => {
      if (wsReady) ws.send(JSON.stringify({ type: 'ping', t: performance.now() }));
    }, 2000);
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'welcome':
        roleReady = true;
        setWsUi('ok', 'connected');
        break;
      case 'pong':
        els.rttChip.hidden = false;
        els.rttLabel.textContent = Math.round(performance.now() - msg.t);
        break;
      case 'peer':
        els.peerChip.hidden = !msg.connected;
        break;
      case 'replaced':
        replacing = true;
        stopTalk();
        setWsUi('red', 'another console took over');
        break;
    }
  };

  ws.onclose = () => {
    wsReady = false;
    roleReady = false;
    clearInterval(pingTimer);
    els.peerChip.hidden = true;
    els.rttChip.hidden = true;
    stopTalk();
    if (replacing) return; // stay closed after a takeover
    setWsUi('red', 'reconnecting…');
    setTimeout(connectWs, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, 5000);
  };

  ws.onerror = () => ws.close();
}

function setWsUi(color, label) {
  els.wsDot.className = 'dot dot-' + color;
  els.wsLabel.textContent = label;
}

// ------------------------------------------------------------- Wi-Fi panel

async function refreshWifi() {
  try {
    const [wifi, info] = await Promise.all([
      fetch('/api/wifi').then((r) => r.json()),
      fetch('/api/info').then((r) => r.json()),
    ]);
    els.wifiSsid.textContent = wifi.ssid || 'not connected';
    els.wifiIp.textContent = wifi.ip || 'not connected';
    els.ipList.innerHTML = '';
    for (const item of info.ips) {
      const row = document.createElement('div');
      row.className = 'ip-row';
      const addr = document.createElement('span');
      addr.className = 'addr';
      addr.textContent = `${item.address}:${info.port}`;
      const btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.textContent = 'copy';
      btn.onclick = () => {
        navigator.clipboard.writeText(`${item.address}:${info.port}`);
        btn.textContent = 'copied';
        setTimeout(() => (btn.textContent = 'copy'), 1200);
      };
      row.append(addr, btn);
      els.ipList.appendChild(row);
    }
  } catch { /* server momentarily unreachable mid-switch */ }
}

els.wifiForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const ssid = els.wifiSsidInput.value.trim();
  if (!ssid) { setWifiStatus('Enter a network name first.', 'err'); return; }
  els.wifiBtn.disabled = true;
  setWifiStatus('Switching… the Mac may drop Wi-Fi for up to 20 s.', '');
  try {
    const res = await fetch('/api/wifi/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssid, password: els.wifiPassInput.value }),
    });
    const data = await res.json();
    if (data.ok) {
      setWifiStatus(`Switched to "${ssid}". New IP ${data.ip}. The iPad reconnects automatically.`, 'ok');
      els.wifiPassInput.value = '';
    } else if (data.fallbackCommand) {
      setWifiStatus(`Needs admin rights. Run once in Terminal: ${data.fallbackCommand}`, 'err');
    } else {
      setWifiStatus(data.error || 'Switch failed.', 'err');
    }
  } catch {
    setWifiStatus('Lost the server during the switch. The page recovers on its own.', 'err');
  } finally {
    els.wifiBtn.disabled = false;
    refreshWifi();
  }
});

function setWifiStatus(msg, cls) {
  els.wifiStatus.textContent = msg;
  els.wifiStatus.className = 'wifi-status' + (cls ? ' ' + cls : '');
}

// ------------------------------------------------------------------- theme

const themeBtn = document.getElementById('themeToggle');

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeBtn.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
}

applyTheme(document.documentElement.dataset.theme || 'light');
themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
});

// ------------------------------------------------------------------- boot

connectWs();
refreshWifi();
setWsUi('yellow', 'connecting…');
