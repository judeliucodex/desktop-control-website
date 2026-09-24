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
  sendJson(res, 404, { error: 'Unknown API endpoint' });
}

// --------------------------------------------------------- WebSocket relay

// roles: operator (Mac browser, sends audio) / receiver (iPad, plays audio)
const roles = new Map(); // role -> ws

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function peerOf(role) {
  return role === 'operator' ? 'receiver' : 'operator';
}

function notifyPeer(role, connected) {
  const other = roles.get(peerOf(role));
  if (other && other.readyState === 1) {
    other.send(JSON.stringify({ type: 'peer', role, connected, name: '' }));
  }
}

function takeRole(ws, role, name) {
  const old = roles.get(role);
  if (old && old !== ws) {
    old.send(JSON.stringify({ type: 'replaced' }));
    old.close(4000, 'replaced');
  }
  const hadPeer = roles.has(peerOf(role));
  roles.set(role, ws);
  ws._role = role;
  ws._name = name || role;
  ws.send(JSON.stringify({ type: 'welcome', role, server: '1.0' }));
  ws.send(JSON.stringify({ type: 'peer', role: peerOf(role), connected: roles.has(peerOf(role)) }));
  if (hadPeer) notifyPeer(role, true);
  log(`${role} connected (${ws._name}); roles now: ${[...roles.keys()].join(', ') || 'none'}`);
}

function dropClient(ws) {
  if (ws._role && roles.get(ws._role) === ws) {
    roles.delete(ws._role);
    log(`${ws._role} disconnected; roles now: ${[...roles.keys()].join(', ') || 'none'}`);
    notifyPeer(ws._role, false);
  }
}

function relayControl(ws, msg) {
  const other = roles.get(peerOf(ws._role));
  if (other && other.readyState === 1) other.send(JSON.stringify(msg));
}

function handleWsMessage(ws, data, isBinary) {
  if (isBinary) {
    if (ws._role === 'operator') {
      const rx = roles.get('receiver');
      if (rx && rx.readyState === 1) {
        rx.send(data, { binary: true });
        ws._framesRelayed = (ws._framesRelayed || 0) + 1;
      }
    }
    return;
  }
  const msg = safeParse(data.toString());
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'hello') {
    if (msg.role === 'operator' || msg.role === 'receiver') takeRole(ws, msg.role, msg.name);
    return;
  }
  if (!ws._role) return; // everything below needs a claimed role
  switch (msg.type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
      break;
    case 'talk_start':
      if (ws._role === 'operator') ws._framesRelayed = 0;
      if (ws._role === 'operator') relayControl(ws, { type: msg.type });
      break;
    case 'talk_stop':
      if (ws._role === 'operator') {
        relayControl(ws, { type: msg.type });
        const n = ws._framesRelayed || 0;
        log(`announcement ended: ${n} frames (~${Math.round(n * 40 / 1000)} s of audio)`);
      }
      break;
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
