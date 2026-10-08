// PA Console client: WebSocket link, mic capture, hold-to-talk, Wi-Fi panel.
'use strict';

const $ = (id) => document.getElementById(id);
const els = {
  wsDot: $('wsDot'), wsLabel: $('wsLabel'), fleetChip: $('fleetChip'), fleetDot: $('fleetDot'),
  fleetLabel: $('fleetLabel'),
  rttChip: $('rttChip'), rttLabel: $('rttLabel'),
  ptt: $('ptt'), pttHint: $('pttHint'), onair: $('onair'),
  meterFill: $('meterFill'), chimeToggle: $('chimeToggle'), micSelect: $('micSelect'),
  wifiSsid: $('wifiSsid'), wifiIp: $('wifiIp'), ipList: $('ipList'),
  wifiForm: $('wifiForm'), wifiSsidInput: $('wifiSsidInput'), wifiPassInput: $('wifiPassInput'),
  wifiBtn: $('wifiBtn'), wifiStatus: $('wifiStatus'),
  fleetEmpty: $('fleetEmpty'), fleetList: $('fleetList'), mapCard: $('mapCard'),
  ttsVoice: $('ttsVoice'), ttsText: $('ttsText'), ttsBtn: $('ttsBtn'), ttsStatus: $('ttsStatus'),
};

// ------------------------------------------------------------------ state

let ws = null;
let wsReady = false;
let roleReady = false; // server accepted our operator role
let micReady = false;
let talking = false;
let announcing = false; // a TTS announcement is streaming (server-driven)
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
  if (announcing) { flashHint('announcement in progress'); return; }
  if (!wsReady || !roleReady) { flashHint('not connected'); return; }
  if (!(await ensureMic())) return;
  talking = true;
  ws.send(JSON.stringify({ type: 'talk_start', chime: els.chimeToggle.checked }));
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
  if (e.code !== 'Space') return;
  // Holding space fires repeating keydowns whose default action scrolls the
  // page; swallow those, and only start a new talk on the first press.
  if (e.repeat) { e.preventDefault(); return; }
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
      case 'receivers':
        renderFleet(msg.receivers || []);
        break;
      case 'replaced':
        replacing = true;
        stopTalk();
        setWsUi('red', 'another console took over');
        break;
      case 'error':
        flashHint(msg.message || 'not allowed right now');
        break;
      case 'tts_start':
        // The operator page mirrors the announcement like a live talk.
        announcing = true;
        stopTalk();
        els.onair.hidden = false;
        els.ttsBtn.disabled = true;
        els.ttsBtn.textContent = 'Announcing…';
        setTtsStatus('Announcing on every connected iPad…', '');
        break;
      case 'tts_end':
        announcing = false;
        els.onair.hidden = true;
        els.ttsBtn.textContent = 'Announce';
        break;
    }
  };

  ws.onclose = () => {
    wsReady = false;
    roleReady = false;
    clearInterval(pingTimer);
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

// ------------------------------------------------------------ fleet + map

const markers = new Map(); // iPad name -> L.circleMarker
let fleetMap = null;
let tileFailures = 0;
let mapUsable = false;

function ensureMap() {
  if (!window.L) return null;
  if (!fleetMap) {
    fleetMap = L.map('map', { attributionControl: true, zoomControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    })
      .on('tileerror', () => {
        // No internet for tiles: hide the map, keep the list fully live.
        tileFailures += 1;
        if (tileFailures >= 3 && mapUsable) {
          mapUsable = false;
          els.mapCard.hidden = true;
        }
      })
      .addTo(fleetMap);
    mapUsable = true;
  }
  return fleetMap;
}

function markerColor(muted) {
  return muted ? '#ff5900' : '#050506';
}

function upsertMarker(name, loc, muted) {
  const m = ensureMap();
  if (!m || !loc) return;
  let marker = markers.get(name);
  if (!marker) {
    marker = L.circleMarker([loc.lat, loc.lon], {
      radius: 9,
      weight: 2,
      color: '#ffffff',
      fillColor: markerColor(muted),
      fillOpacity: 0.95,
    })
      .bindTooltip(name, { permanent: true, direction: 'right', offset: [10, 0] })
      .addTo(m);
    markers.set(name, marker);
    const all = [...markers.values()].map((mk) => mk.getLatLng());
    if (all.length === 1) m.setView(all[0], 16);
    else m.fitBounds(L.latLngBounds(all).pad(0.35));
  } else {
    marker.setLatLng([loc.lat, loc.lon]);
    marker.setStyle({ fillColor: markerColor(muted) });
  }
}

function fmtBattery(b) {
  return typeof b === 'number' ? `${Math.round(b * 100)}%` : 'battery n/a';
}

function fmtLocation(r) {
  if (!r.location) return { text: 'Location off', stale: true };
  const age = typeof r.age === 'number' ? r.age : null;
  const ageText = age == null ? '' : age < 60 ? `loc ${age} s ago` : `loc ${Math.round(age / 60)} m ago`;
  const parts = [];
  if (r.location.acc != null) parts.push(`±${Math.round(r.location.acc)} m`);
  if (r.location.speed != null && r.location.speed > 0.5) {
    parts.push(`${(r.location.speed * 3.6).toFixed(0)} km/h`);
  }
  if (ageText) parts.push(ageText);
  return { text: parts.join(' · ') || 'locating…', stale: age != null && age > 90 };
}

function renderFleet(list) {
  els.fleetChip.hidden = false;
  els.fleetLabel.textContent = `${list.length} iPad${list.length === 1 ? '' : 's'}`;
  els.fleetDot.className = `dot ${list.length > 0 ? 'dot-ok' : ''}`;
  els.fleetEmpty.hidden = list.length > 0;
  els.fleetList.textContent = '';

  const seen = new Set();
  for (const r of list) {
    const key = r.id || r.name;
    seen.add(key);
    const row = document.createElement('div');
    row.className = 'fleet-row';

    const dot = document.createElement('span');
    dot.className = 'fleet-dot';

    const name = document.createElement('span');
    name.className = 'fleet-name';
    const idSpan = document.createElement('span');
    idSpan.className = 'fleet-id';
    idSpan.textContent = r.id ? `${r.id} · ` : '';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = r.name;
    name.append(idSpan, nameSpan);

    const rename = document.createElement('button');
    rename.className = 'fleet-rename';
    rename.textContent = 'rename';
    rename.title = 'Rename this iPad';
    rename.onclick = () => beginFleetRename(key, row, nameSpan);

    row.append(dot, name, rename);
    if (r.muted) {
      const muted = document.createElement('span');
      muted.className = 'fleet-chip-muted';
      muted.textContent = 'MUTED';
      row.appendChild(muted);
    }

    const meta = document.createElement('span');
    meta.className = 'fleet-meta';
    const battery = document.createElement('span');
    battery.textContent = fmtBattery(r.battery);
    const loc = document.createElement('span');
    const locInfo = fmtLocation(r);
    loc.textContent = locInfo.text;
    if (locInfo.stale) loc.className = 'stale';
    if (r.location) {
      loc.title = `${r.location.lat.toFixed(5)}, ${r.location.lon.toFixed(5)}`;
    }
    meta.append(battery, loc);
    row.appendChild(meta);
    els.fleetList.appendChild(row);

    if (r.location) {
      if (mapUsable || tileFailures < 3) {
        els.mapCard.hidden = false;
        upsertMarker(key, r.location, r.muted);
      }
    }
  }

  // Remove markers for iPads that left.
  for (const [key, marker] of markers) {
    if (!seen.has(key)) {
      marker.remove();
      markers.delete(key);
    }
  }
  if (list.length === 0 && fleetMap) {
    els.mapCard.hidden = true;
  }
  // Roster changes can resize the map container (flex layout); let Leaflet
  // re-measure so tiles and markers stay aligned.
  if (fleetMap) setTimeout(() => fleetMap.invalidateSize(), 50);
}

// ------------------------------------------------------- fleet rename (op)

let renamingKey = null;

function beginFleetRename(key, row, nameSpan) {
  if (renamingKey) return; // one inline editor at a time
  renamingKey = key;
  const current = nameSpan.textContent;
  nameSpan.textContent = '';

  const input = document.createElement('input');
  input.className = 'fleet-rename-input';
  input.value = current;
  input.maxLength = 40;
  const done = (save) => {
    renamingKey = null;
    input.remove();
    if (save) {
      const value = input.value.trim();
      if (value && value !== current && wsReady) {
        ws.send(JSON.stringify({ type: 'rename', id: key, name: value }));
        return; // roster refresh re-renders the row
      }
    }
    nameSpan.textContent = current;
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') done(true);
    else if (e.key === 'Escape') done(false);
  });
  input.addEventListener('blur', () => done(false));
  nameSpan.appendChild(input);
  input.focus();
  input.select();
}

// ------------------------------------------------------------ text to speech

let voicesLoaded = false;

async function loadVoices() {
  if (voicesLoaded) return;
  try {
    const data = await fetch('/api/voices').then((r) => r.json());
    if (!data.voices || data.voices.length === 0) throw new Error(data.error || 'no voices');
    els.ttsVoice.innerHTML = '';
    for (const v of data.voices) {
      const opt = document.createElement('option');
      opt.value = v.name;
      // Enhanced/premium variants read better; surface the quality in the label.
      opt.textContent = v.quality === 'default' ? `${v.name} (${v.lang})` : `${v.name}`;
      els.ttsVoice.appendChild(opt);
    }
    if (data.default) els.ttsVoice.value = data.default;
    voicesLoaded = true;
  } catch (err) {
    els.ttsVoice.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'voices unavailable';
    els.ttsVoice.appendChild(opt);
  }
}

els.ttsBtn.addEventListener('click', async () => {
  const text = els.ttsText.value.trim();
  if (!text) { setTtsStatus('Type something to announce first.', 'err'); return; }
  els.ttsBtn.disabled = true;
  setTtsStatus('Announcing…', '');
  try {
    const res = await fetch('/api/announce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voice: els.ttsVoice.value || undefined,
        chime: els.chimeToggle.checked,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      const secs = Math.round(data.durationMs / 1000);
      setTtsStatus(`Announced in ${secs} s on every connected iPad.`, 'ok');
    } else {
      setTtsStatus(data.error || 'Announcement failed.', 'err');
    }
  } catch {
    setTtsStatus('Lost the server mid-announcement.', 'err');
  } finally {
    els.ttsBtn.disabled = announcing; // tts_end restores the button
    if (!announcing) els.ttsBtn.textContent = 'Announce';
  }
});

function setTtsStatus(msg, cls) {
  els.ttsStatus.textContent = msg;
  els.ttsStatus.className = 'wifi-status' + (cls ? ' ' + cls : '');
}

// ------------------------------------------------------------------- boot

connectWs();
refreshWifi();
loadVoices();
setWsUi('yellow', 'connecting…');
