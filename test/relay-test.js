// End-to-end relay test: an operator and a receiver connect to the running
// server; the operator sends talk control + PCM frames and the receiver must
// receive them intact, and both must get ping/pong RTT echoes.
'use strict';

const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const URL = `ws://localhost:${PORT}/ws`;

let failures = 0;
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures++;
}

function connect(role) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.binaryType = 'nodebuffer';
    const client = { ws, messages: [], binary: [] };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role, name: `test-${role}` })));
    ws.on('message', (data, isBinary) => {
      if (isBinary) client.binary.push(data);
      else client.messages.push(JSON.parse(data.toString()));
    });
    ws.on('error', reject);
    ws.on('open', () => resolve(client));
  });
}

const waitFor = (client, type, ms = 3000) =>
  new Promise((resolve, reject) => {
    const found = client.messages.find((m) => m.type === type);
    if (found) return resolve(found);
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
    const orig = client.ws.listeners('message');
    client.ws.on('message', (data, isBinary) => {
      if (!isBinary && JSON.parse(data.toString()).type === type) {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()));
      }
    });
    void orig;
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1. Receiver connects first, sees operator absent.
  const rx = await connect('receiver');
  const rxWelcome = await waitFor(rx, 'welcome');
  check('receiver welcome', rxWelcome.role === 'receiver');
  const rxPeerAbsent = await waitFor(rx, 'peer');
  check('receiver told operator absent', rxPeerAbsent.connected === false);

  // 2. Operator connects; receiver learns operator is present.
  const op = await connect('operator');
  await waitFor(op, 'welcome');
  await sleep(300);
  const rxPeerPresent = rx.messages.filter((m) => m.type === 'peer').at(-1);
  check('receiver told operator present', rxPeerPresent && rxPeerPresent.connected === true);

  // 3. Operator streams control + binary; receiver gets both.
  op.ws.send(JSON.stringify({ type: 'talk_start' }));
  op.ws.send(Buffer.from([1, 2, 3, 4]));
  op.ws.send(Buffer.alloc(1920, 0x5a));
  op.ws.send(JSON.stringify({ type: 'talk_stop' }));
  await waitFor(rx, 'talk_start');
  await sleep(300);
  check('receiver got talk_start', rx.messages.some((m) => m.type === 'talk_start'));
  check('receiver got talk_stop', rx.messages.some((m) => m.type === 'talk_stop'));
  check('receiver got 2 audio frames', rx.binary.length === 2);
  check('audio bytes intact', rx.binary[1].length === 1920 && rx.binary[1][0] === 0x5a);

  // 4. ping/pong echo on both sides.
  op.ws.send(JSON.stringify({ type: 'ping', t: 123.25 }));
  const pong = await waitFor(op, 'pong');
  check('operator pong echo', pong.t === 123.25);
  rx.ws.send(JSON.stringify({ type: 'ping', t: 42 }));
  check('receiver pong echo', (await waitFor(rx, 'pong')).t === 42);

  // 5. A second operator replaces the first.
  const op2 = await connect('operator');
  await waitFor(op2, 'welcome');
  const replaced = await waitFor(op, 'replaced');
  check('first operator replaced', replaced.type === 'replaced');
  await sleep(200);

  // 6. Relay still works with the new operator.
  op2.ws.send(JSON.stringify({ type: 'talk_start' }));
  const deadline2 = Date.now() + 2000;
  while (rx.messages.filter((m) => m.type === 'talk_start').length < 2 && Date.now() < deadline2) {
    await sleep(50);
  }
  const rxStarts = rx.messages.filter((m) => m.type === 'talk_start').length;
  check('relay works after replacement', rxStarts >= 2);

  op2.ws.close();
  rx.ws.close();
  await sleep(200);

  console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('Test crashed:', e.message);
  process.exit(1);
});
