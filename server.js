// PA system server: hosts the operator website, relays mic audio over a
// WebSocket to the iPad app, advertises itself via Bonjour, and exposes a
// small HTTP API for switching the Mac's Wi-Fi network.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { WebSocketServer } = require('ws');
const { Bonjour } = require('bonjour-service');

const execFileP = promisify(execFile);
const NETWORKSETUP = '/usr/sbin/networksetup';
const BASE_PORT = 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server kept alive):', err);
});

// ---------------------------------------------------------------- static site

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ------------------------------------------------------------- Wi-Fi helpers

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function detectWifiInterface() {
  const { stdout } = await execFileP(NETWORKSETUP, ['-listallhardwareports'], { timeout: 5000 });
  const lines = stdout.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('Wi-Fi')) {
      const dev = lines[i + 1] || '';
      const m = dev.match(/Device:\s+(\S+)/);
      if (m) return m[1];
    }
  }
  return null;
}

async function currentSsid(iface) {
  // -getairportnetwork is fastest but lies on some macOS versions
  // ("not associated" while connected), so fall back to system_profiler.
  try {
    const { stdout } = await execFileP(NETWORKSETUP, ['-getairportnetwork', iface], { timeout: 5000 });
    const m = stdout.match(/Current Wi-Fi Network:\s*(.+)/);
    if (m) return m[1].trim();
  } catch { /* try system_profiler */ }
  try {
    const { stdout } = await execFileP('/usr/sbin/system_profiler', ['SPAirPortDataType'], { timeout: 15000 });
    const lines = stdout.split('\n');
    let inSection = false;
    for (const line of lines) {
      if (line.includes('Current Network Information:')) {
        inSection = true;
        continue;
      }
      if (inSection) {
        if (!line.trim()) continue;
        const trimmed = line.trim();
        return trimmed.endsWith(':') ? trimmed.slice(0, -1) : null;
      }
    }
  } catch { /* no SSID available */ }
  return null;
}

async function currentIp(iface) {
  try {
    const { stdout } = await execFileP('/usr/sbin/ipconfig', ['getifaddr', iface], { timeout: 5000 });
    const ip = stdout.trim();
    return ip || null;
  } catch {
    return null;
  }
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Switches the Mac's Wi-Fi to ssid/password and waits for it to rejoin.
// Returns { ok, ip?, error?, fallbackCommand? }.
async function switchWifi(ssid, password) {
  const iface = await detectWifiInterface();
  if (!iface) return { ok: false, error: 'No Wi-Fi interface found on this Mac.' };

  const args = ['--setairportnetwork', iface, ssid];
  if (password) args.push(password);
  try {
    await execFileP(NETWORKSETUP, args, { timeout: 20000 });
  } catch (e) {
    const msg = (e.stderr || e.message || String(e)).trim();
    return {
      ok: false,
      error: `networksetup refused: ${msg}`,
      fallbackCommand: `sudo ${NETWORKSETUP} ${args.map(shellQuote).join(' ')}`,
    };
  }

  // Wait for the interface to come back with an address on the new network.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(1000);
    const ip = await currentIp(iface);
    if (ip) {
      const joined = await currentSsid(iface);
      if (!joined || joined === ssid) return { ok: true, ssid, ip, interface: iface };
    }
  }
  return {
    ok: false,
    error: 'Mac did not rejoin within 20 s — check the SSID and password, then retry.',
  };
}

// ------------------------------------------------------------- LAN addresses

function lanIPv4s() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ iface: name, address: a.address });
    }
  }
  return out;
}

// ------------------------------------------------------------------ Bonjour

// A multicast send can fail transiently (interface flap, EADDRNOTAVAIL);
// mDNS failures must never take the relay down, so log and carry on.
const bonjour = new Bonjour({}, (err) => log('mDNS error (ignored):', err.code || err.message));
let advertised = false;
let lastIpsJson = '';

function publishService() {
  const ips = lanIPv4s();
  const json = JSON.stringify(ips);
  if (advertised && json === lastIpsJson) return;
  lastIpsJson = json;
  const republish = () => {
    advertised = true;
    log(`Bonjour: advertising "iPad-PA" as _paudio._tcp on port ${server.address().port}`);
  };
  if (advertised) {
    bonjour.unpublishAll(() => {
      bonjour.publish({ name: 'iPad-PA', type: 'paudio', port: server.address().port, txt: { v: '1' } });
      republish();
    });
  } else {
    bonjour.publish({ name: 'iPad-PA', type: 'paudio', port: server.address().port, txt: { v: '1' } });
    republish();
  }
}

// Poll for LAN changes so Bonjour points at the current network after a switch.
setInterval(publishService, 5000);

// --------------------------------------------------------------------- TTS

// Text-to-speech announcements: render with the built-in macOS `say` engine to
// 24 kHz mono Int16 (the same wire format as mic audio), then stream to every
// receiver paced at real time, so iPads play it through their normal path
// (chime, volume, ON AIR) with no app changes. `say` pauses at commas and
// periods as part of its prosody.
const SAY = '/usr/bin/say';
const TTS_FRAME_BYTES = 1920; // 40 ms of 24 kHz mono Int16
const MAX_TTS_CHARS = 2000;
let announcing = false;
let operatorTalking = false;

function parseVoices(stdout) {
  const voices = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^(.+?)\s+([a-z]{2,3}[-_][A-Za-z]{2})\s*(?:#\s*(.*))?$/);
    if (!m) continue;
    const name = m[1].trim();
    voices.push({
      name,
      lang: m[2],
      quality: /premium/i.test(name) ? 'premium' : /enhanced/i.test(name) ? 'enhanced' : 'default',
    });
  }
  return voices;
}

async function ttsVoices() {
  const { stdout } = await execFileP(SAY, ['-v', '?'], { timeout: 10000 });
  return parseVoices(stdout);
}

function defaultVoice(voices) {
  return (
    voices.find((v) => v.name === 'Samantha') ||
    voices.find((v) => v.lang.startsWith('en_US')) ||
    voices[0]
  );
}

function parseWavPcm(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return buf.subarray(off + 8, Math.min(buf.length, off + 8 + size));
    off += 8 + size + (size % 2);
  }
  return null;
}

function announce(text, voice, chime) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };

    if (!operator || operator.readyState !== 1) return fail(new Error('No operator console is connected.'));
    const tmp = path.join(os.tmpdir(), `pa-tts-${Date.now()}.wav`);
    execFile(SAY, ['-v', voice, '-o', tmp, '--data-format=LEI16@24000', text], { timeout: 120000 }, (err) => {
      if (err) {
        fs.unlink(tmp, () => {});
        return fail(new Error(`Speech failed: ${(err.message || '').split('\n')[0]}`));
      }
      let pcm;
      try {
        pcm = parseWavPcm(fs.readFileSync(tmp));
      } finally {
        fs.unlink(tmp, () => {});
      }
      if (!pcm || pcm.length === 0) return fail(new Error('Speech rendered no audio.'));

      announcing = true;
      const frames = Math.ceil(pcm.length / TTS_FRAME_BYTES);
      log(`TTS: announcing ${frames} frames (~${Math.round((frames * 40) / 1000)} s) with voice "${voice}" to ${receivers.size} receiver(s)`);
      eachOpenReceiver((rx) => rx.send(JSON.stringify({ type: 'talk_start', chime: chime !== false })));
      operatorSend({ type: 'tts_start' });
      let off = 0;
      const timer = setInterval(() => {
        let alive = 0;
        eachOpenReceiver((rx) => {
          if (rx.bufferedAmount > AUDIO_DROP_BYTES) return;
          rx.send(pcm.subarray(off, Math.min(off + TTS_FRAME_BYTES, pcm.length)), { binary: true });
          alive++;
        });
        off += TTS_FRAME_BYTES;
        if (alive === 0 || off >= pcm.length) {
          clearInterval(timer);
          eachOpenReceiver((rx) => rx.send(JSON.stringify({ type: 'talk_stop' })));
          operatorSend({ type: 'tts_end' });
          announcing = false;
          if (alive === 0) return fail(new Error('All iPads disconnected mid-announcement.'));
          done({ durationMs: Math.round((pcm.length / 2 / 24000) * 1000) });
        }
      }, 40);
    });
  });
}

// ------------------------------------------------------------- HTTP handler

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function handleApi(req, res) {
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && url === '/api/info') {
    const iface = await detectWifiInterface();
    const ssid = iface ? await currentSsid(iface) : null;
    return sendJson(res, 200, {
      hostname: os.hostname(),
      port: server.address().port,
      ips: lanIPv4s(),
      ssid,
    });
  }
  if (req.method === 'GET' && url === '/api/wifi') {
    const iface = await detectWifiInterface();
    const ssid = iface ? await currentSsid(iface) : null;
    const ip = iface ? await currentIp(iface) : null;
    return sendJson(res, 200, { ssid, ip, interface: iface });
  }
  if (req.method === 'POST' && url === '/api/wifi/switch') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let ssid, password;
      try {
        ({ ssid, password } = JSON.parse(body || '{}'));
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Bad JSON body.' });
      }
      if (!ssid || typeof ssid !== 'string') {
        return sendJson(res, 400, { ok: false, error: 'Missing "ssid".' });
      }
      log(`Wi-Fi switch requested -> "${ssid}"`);
      const result = await switchWifi(ssid.trim(), typeof password === 'string' ? password : '');
      log(`Wi-Fi switch result: ${result.ok ? `ok, ip=${result.ip}` : result.error}`);
      sendJson(res, result.ok ? 200 : 502, result);
      publishService(); // re-announce on the new network immediately
    });
    return;
  }
  if (req.method === 'GET' && url === '/api/voices') {
    try {
      const voices = await ttsVoices();
      const def = defaultVoice(voices);
      return sendJson(res, 200, { voices, default: def ? def.name : null });
    } catch (e) {
      return sendJson(res, 501, { error: `Voice listing unavailable: ${e.message}` });
    }
  }
  if (req.method === 'POST' && url === '/api/announce') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let text, voice, chime;
      try {
        ({ text, voice, chime } = JSON.parse(body || '{}'));
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Bad JSON body.' });
      }
      if (typeof text !== 'string' || !text.trim()) {
        return sendJson(res, 400, { ok: false, error: 'Type something to announce.' });
      }
      if (text.length > MAX_TTS_CHARS) {
        return sendJson(res, 400, { ok: false, error: `Text is too long (max ${MAX_TTS_CHARS} characters).` });
      }
      if (announcing) return sendJson(res, 409, { ok: false, error: 'An announcement is already playing.' });
      if (operatorTalking) return sendJson(res, 409, { ok: false, error: 'Release the talk button first.' });

      let voices = [];
      try {
        voices = await ttsVoices();
      } catch (e) {
        return sendJson(res, 501, { ok: false, error: `Speech engine unavailable: ${e.message}` });
      }
      const chosen = voices.find((v) => v.name === voice) || defaultVoice(voices);
      try {
        const result = await announce(text.trim(), chosen.name, chime);
        sendJson(res, 200, { ok: true, voice: chosen.name, ...result });
      } catch (e) {
        sendJson(res, 502, { ok: false, error: e.message });
      }
    });
    return;
  }
  sendJson(res, 404, { error: 'Unknown API endpoint' });
}

// --------------------------------------------------------- WebSocket relay

// One operator (Mac browser, sends audio) and a fleet of receivers (iPads).
const MAX_RECEIVERS = 8;
let operator = null;
let anonCounter = 0;
const receivers = new Map(); // ws -> {id, name, muted, battery, location, lastLocAt}

// Persistent per-iPad identity: id -> {name, muted}. Written to disk so
// nicknames and mute state survive reconnects AND server restarts.
const FLEET_IDS_PATH = path.join(__dirname, 'fleet-ids.json');
const knownFleet = new Map();
try {
  for (const [id, rec] of Object.entries(JSON.parse(fs.readFileSync(FLEET_IDS_PATH, 'utf8')))) {
    if (rec && typeof rec.name === 'string') knownFleet.set(id, { name: rec.name, muted: !!rec.muted });
  }
} catch {
  // first run or unreadable file: start with an empty registry
}
function persistFleetIds() {
  try {
    const named = [...knownFleet].filter(([id]) => !id.startsWith('anon-'));
    fs.writeFileSync(FLEET_IDS_PATH, JSON.stringify(Object.fromEntries(named), null, 2));
  } catch (e) {
    log('fleet-ids.json write failed:', e.message);
  }
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function uniqueName(base) {
  const taken = new Set([...receivers.values()].map((r) => r.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}

function operatorSend(msg) {
  if (operator && operator.readyState === 1) operator.send(JSON.stringify(msg));
}

function receiverRoster() {
  const now = Date.now();
  return [...receivers.values()].map((r) => ({
    id: r.id,
    name: r.name,
    muted: r.muted,
    battery: r.battery,
    location: r.location
      ? { ...r.location, age: Math.round((now - r.lastLocAt) / 1000) }
      : null,
  }));
}

function broadcastRoster() {
  operatorSend({ type: 'receivers', receivers: receiverRoster() });
}

function broadcastOperatorPresence() {
  const connected = !!(operator && operator.readyState === 1);
  const msg = JSON.stringify({ type: 'peer', role: 'operator', connected });
  for (const [ws] of receivers) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function eachOpenReceiver(fn) {
  for (const [ws] of receivers) {
    if (ws.readyState === 1) fn(ws);
  }
}

function addReceiver(ws, msg) {
  if (receivers.size >= MAX_RECEIVERS) {
    ws.send(JSON.stringify({ type: 'full', limit: MAX_RECEIVERS }));
    ws.close(4001, 'full');
    log(`receiver rejected: fleet full (${MAX_RECEIVERS})`);
    return;
  }
// Identity: the iPad's typed id (falls back to a per-connection id for
// clients that predate the identity feature, e.g. old tests).
const id = String(msg.id || '').trim().slice(0, 64) || `anon-${++anonCounter}`;
  const known = knownFleet.get(id);
  // The server's stored nickname wins: it carries console renames. The app
  // adopts it via the `yourname` push below.
  const requested = String(msg.name || '').trim().slice(0, 40) || 'iPad';
  const base = known ? known.name : requested;
  const clean = uniqueName(base);
  const muted = known ? known.muted : false;
  receivers.set(ws, { id, name: clean, muted, battery: null, location: null, lastLocAt: 0 });
  ws._role = 'receiver';
  ws._rxId = id;
  knownFleet.set(id, { name: clean, muted });
  persistFleetIds();
  ws.send(JSON.stringify({ type: 'welcome', role: 'receiver', server: '2.0' }));
  ws.send(JSON.stringify({ type: 'yourname', id, name: clean, muted }));
  broadcastOperatorPresence();
  broadcastRoster();
  log(`receiver connected (${id} / "${clean}"); fleet size ${receivers.size}`);
}

function renameReceiver(id, name, sourceWs) {
  const trimmed = String(name || '').trim().slice(0, 40);
  if (!trimmed) return;
  const known = knownFleet.get(id) || { muted: false };
  known.name = trimmed;
  knownFleet.set(id, known);
  persistFleetIds();
  for (const [ws, r] of receivers) {
    if (r.id !== id) continue;
    r.name = uniqueName(trimmed);
    known.name = r.name;
    if (ws.readyState === 1 && ws !== sourceWs) {
      ws.send(JSON.stringify({ type: 'yourname', id, name: r.name, muted: r.muted }));
    }
  }
  persistFleetIds();
  broadcastRoster();
  log(`renamed receiver ${id} -> "${trimmed}"`);
}

function takeOperator(ws, name) {
  if (operator && operator !== ws) {
    operator.send(JSON.stringify({ type: 'replaced' }));
    operator.close(4000, 'replaced');
  }
  operator = ws;
  ws._role = 'operator';
  ws._name = String(name || 'Mac Console').trim().slice(0, 40);
  ws.send(JSON.stringify({ type: 'welcome', role: 'operator', server: '2.0' }));
  broadcastOperatorPresence();
  broadcastRoster(); // tell the new operator who is already connected
  log(`operator connected (${ws._name})`);
}

function dropClient(ws) {
  if (ws === operator) {
    operator = null;
    operatorTalking = false; // a gone operator cannot keep the mic busy
    log('operator disconnected');
    broadcastOperatorPresence();
  } else if (receivers.has(ws)) {
    const r = receivers.get(ws);
    receivers.delete(ws);
    log(`receiver disconnected (${r.name}); fleet size ${receivers.size}`);
    broadcastRoster();
  }
}

// A receiver too far behind drops this frame rather than buffering seconds of
// audio delay; realtime playback beats completeness here.
const AUDIO_DROP_BYTES = 1 * 1024 * 1024;

function handleWsMessage(ws, data, isBinary) {
  if (isBinary) {
    if (ws._role === 'operator') {
      eachOpenReceiver((rx) => {
        if (rx.bufferedAmount > AUDIO_DROP_BYTES) return;
        rx.send(data, { binary: true });
      });
      ws._framesRelayed = (ws._framesRelayed || 0) + 1;
    }
    return;
  }
  const msg = safeParse(data.toString());
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'hello') {
    if (msg.role === 'operator') takeOperator(ws, msg.name);
    else if (msg.role === 'receiver') addReceiver(ws, msg);
    return;
  }
  if (!ws._role) return; // everything below needs a claimed role
  switch (msg.type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
      break;
    case 'talk_start':
      if (ws._role === 'operator') {
        if (announcing) {
          ws.send(JSON.stringify({ type: 'error', message: 'Announcement in progress. Wait for it to finish.' }));
          break;
        }
        operatorTalking = true;
        ws._framesRelayed = 0;
        eachOpenReceiver((rx) => rx.send(JSON.stringify({ type: 'talk_start', chime: msg.chime !== false })));
      }
      break;
    case 'talk_stop':
      if (ws._role === 'operator') {
        operatorTalking = false;
        eachOpenReceiver((rx) => rx.send(JSON.stringify({ type: 'talk_stop' })));
        const n = ws._framesRelayed || 0;
        log(`announcement ended: ${n} frames (~${Math.round(n * 40 / 1000)} s of audio) to ${receivers.size} receiver(s)`);
      }
      break;
    case 'status': { // receiver reports {muted, battery}
      const r = receivers.get(ws);
      if (!r) return;
      if (typeof msg.muted === 'boolean') r.muted = msg.muted;
      if (typeof msg.battery === 'number') r.battery = Math.max(0, Math.min(1, msg.battery));
      knownFleet.set(r.id, { name: r.name, muted: r.muted });
      persistFleetIds();
      broadcastRoster();
      break;
    }
    case 'rename': {
      // The operator renames by id; a receiver renames itself. The change is
      // pushed to the iPad (yourname) so it sticks on the device too.
      if (ws._role === 'operator' && msg.id) {
        renameReceiver(String(msg.id).trim().slice(0, 64), msg.name, null);
      } else if (ws._role === 'receiver' && ws._rxId) {
        renameReceiver(ws._rxId, msg.name, ws);
      }
      break;
    }
    case 'location': { // receiver reports {lat, lon, accuracy, speed}
      const r = receivers.get(ws);
      if (!r) return;
      const now = Date.now();
      if (now - r.lastLocAt < 2000) return; // throttle per iPad
      const lat = Number(msg.lat);
      const lon = Number(msg.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return;
      const acc = Number(msg.accuracy);
      const speed = Number(msg.speed);
      r.location = {
        lat,
        lon,
        acc: Number.isFinite(acc) ? acc : null,
        speed: Number.isFinite(speed) ? speed : null,
      };
      r.lastLocAt = now;
      broadcastRoster();
      break;
    }
    default:
      break;
  }
}

// -------------------------------------------------------------------- server

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return handleApi(req, res);
  return serveStatic(req, res);
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('message', (data, isBinary) => {
    try {
      handleWsMessage(ws, data, isBinary);
    } catch (e) {
      log('WS handler error:', e.message);
    }
  });
  ws.on('close', () => dropClient(ws));
  ws.on('error', () => {});
});

// Terminate sockets that stop answering protocol-level pings, so a dead iPad
// cannot hold a fleet slot forever.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      dropClient(ws);
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

function listen(port) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && port < BASE_PORT + 10) {
      log(`Port ${port} busy, trying ${port + 1}...`);
      listen(port + 1);
    } else {
      console.error(e);
      process.exit(1);
    }
  });
  server.listen(port, () => {
    const p = server.address().port;
    log(`PA server running`);
    log(`  Operator site : http://localhost:${p}   (open this in the Mac's browser)`);
    for (const { address } of lanIPv4s()) {
      log(`  On the network: ws://${address}:${p}/ws   (for the iPad app)`);
    }
    publishService();
  });
}

listen(BASE_PORT);
