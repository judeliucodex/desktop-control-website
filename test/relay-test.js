// End-to-end relay tests for the multi-receiver PA server:
// fleet roster, audio fan-out, mute/location reporting, the 8-receiver cap,
// operator replacement, and ping/pong RTT echoes.
'use strict';

const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const URL = `ws://localhost:${PORT}/ws`;

let failures = 0;
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures++;
}

function connect(role, name, id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.binaryType = 'nodebuffer';
    const client = { ws, messages: [], binary: [] };
    const hello = { type: 'hello', role, name: name || `test-${role}` };
    if (id) hello.id = id;
    ws.on('open', () => ws.send(JSON.stringify(hello)));
    ws.on('message', (data, isBinary) => {
      if (isBinary) client.binary.push(data);
      else client.messages.push(JSON.parse(data.toString()));
    });
    ws.on('error', reject);
    ws.on('open', () => resolve(client));
  });
}

function waitFor(client, type, ms = 3000) {
  return new Promise((resolve, reject) => {
    const found = client.messages.find((m) => m.type === type);
    if (found) return resolve(found);
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
    client.ws.on('message', (data, isBinary) => {
      if (!isBinary && JSON.parse(data.toString()).type === type) {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()));
      }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const last = (client, type) => client.messages.filter((m) => m.type === type).at(-1);

(async () => {
  // 1. Operator first; fleet starts empty.
  const op = await connect('operator');
  const opWelcome = await waitFor(op, 'welcome');
  check('operator welcome', opWelcome.role === 'operator');
  await sleep(150);
  const emptyRoster = last(op, 'receivers');
  check('operator sees empty roster', emptyRoster && emptyRoster.receivers.length === 0);

  // 2. Two receivers join with distinct names; operator roster tracks them.
  const rx1 = await connect('receiver', "Jude's iPad");
  await sleep(150);
  let roster = last(op, 'receivers');
  check('roster has 1 iPad', roster && roster.receivers.length === 1);
  check('roster name matches', roster.receivers[0].name === "Jude's iPad");

  const rx2 = await connect('receiver', 'Kitchen iPad');
  await sleep(150);
  roster = last(op, 'receivers');
  check('roster has 2 iPads', roster && roster.receivers.length === 2);

  // 3. Mute + battery status updates flow through.
  rx1.ws.send(JSON.stringify({ type: 'status', muted: true, battery: 0.42 }));
  await sleep(200);
  roster = last(op, 'receivers');
  const jude = roster.receivers.find((r) => r.name === "Jude's iPad");
  check('mute state visible', jude && jude.muted === true);
  check('battery visible', jude && jude.battery === 0.42);

  // 4. Location reports update the roster with age.
  rx2.ws.send(JSON.stringify({ type: 'location', lat: 22.3193, lon: 114.1694, accuracy: 12, speed: 0 }));
  await sleep(200);
  roster = last(op, 'receivers');
  const kitchen = roster.receivers.find((r) => r.name === 'Kitchen iPad');
  check('location visible', kitchen && kitchen.location && Math.abs(kitchen.location.lat - 22.3193) < 0.001);
  check('location age present', kitchen.location && typeof kitchen.location.age === 'number');

  // 5. Audio fan-out: both receivers get talk control + identical binary.
  op.ws.send(JSON.stringify({ type: 'talk_start', chime: true }));
  op.ws.send(Buffer.alloc(1920, 0x5a));
  op.ws.send(Buffer.alloc(1920, 0xa5));
  op.ws.send(JSON.stringify({ type: 'talk_stop' }));
  await waitFor(rx1, 'talk_start');
  await sleep(300);
  check('rx1 got talk_start with chime', rx1.messages.some((m) => m.type === 'talk_start' && m.chime === true));
  check('rx1 got talk_stop', rx1.messages.some((m) => m.type === 'talk_stop'));
  check('rx1 got 2 audio frames', rx1.binary.length === 2);
  check('rx2 got talk_start', rx2.messages.some((m) => m.type === 'talk_start' && m.chime === true));
  check('rx2 got identical 2 audio frames', rx2.binary.length === 2 && rx2.binary[0].length === 1920 && rx2.binary[1][0] === 0xa5);

  // 6. Receiver disconnect removes it from the roster.
  rx2.ws.close();
  await sleep(300);
  roster = last(op, 'receivers');
  check('roster back to 1 after disconnect', roster && roster.receivers.length === 1);

  // 7. Invalid location values are rejected (roster unchanged, still no location for rx1).
  const before = last(op, 'receivers').receivers[0];
  rx1.ws.send(JSON.stringify({ type: 'location', lat: 999, lon: 114 }));
  await sleep(200);
  const after = last(op, 'receivers').receivers[0];
  check('invalid location rejected', after.location === (before.location || null) && !after.location);

  // 8. Ninth receiver hits the cap.
  const extra = [];
  for (let i = 0; i < 8; i++) {
    extra.push(await connect('receiver', `Pad ${i + 1}`));
    await sleep(30);
  }
  await sleep(200);
  const ninth = await connect('receiver', 'Late iPad');
  const full = await waitFor(ninth, 'full');
  check('ninth receiver gets full', full.limit === 8);
  await sleep(100);
  roster = last(op, 'receivers');
  check('roster capped at 8', roster && roster.receivers.length === 8);

  // 9. Operator replacement leaves receivers untouched and audio flowing.
  const op2 = await connect('operator', 'Second Console');
  await waitFor(op, 'replaced');
  check('first operator replaced', true);
  await sleep(300);
  op2.ws.send(JSON.stringify({ type: 'talk_start', chime: false }));
  await sleep(400);
  const starts = rx1.messages.filter((m) => m.type === 'talk_start').length;
  check('relay works after replacement', starts >= 2);
  check('receiver still sees operator presence', last(rx1, 'peer') && last(rx1, 'peer').connected === true);

  // 10. ping/pong echo.
  op2.ws.send(JSON.stringify({ type: 'ping', t: 77 }));
  check('pong echo', (await waitFor(op2, 'pong')).t === 77);

  [op, op2, rx1, ninth, ...extra].forEach((c) => c.ws.close());
  await sleep(200);

  // 11. Persistent identity: id hello, roster id, console rename, yourname,
  // reconnect restores server-stored name + mute. (Fresh operator: every
  // earlier client was closed above.)
  const op3 = await connect('operator');
  await sleep(150);
  const stage = await connect('receiver', 'Stage', 'PA-01');
  await sleep(200);
  const yourName1 = last(stage, 'yourname');
  check('yourname echoes on hello', yourName1 && yourName1.name === 'Stage' && yourName1.id === 'PA-01');
  roster = last(op3, 'receivers');
  const stageRow = roster.receivers.find((r) => r.id === 'PA-01');
  check('roster carries id', !!stageRow && stageRow.name === 'Stage');

  op3.ws.send(JSON.stringify({ type: 'rename', id: 'PA-01', name: 'Auditorium' }));
  await sleep(250);
  const yourName2 = last(stage, 'yourname');
  check('yourname after console rename', yourName2 && yourName2.name === 'Auditorium');
  roster = last(op3, 'receivers');
  check('roster renamed', roster.receivers.some((r) => r.id === 'PA-01' && r.name === 'Auditorium'));

  stage.ws.send(JSON.stringify({ type: 'status', muted: true }));
  await sleep(200);
  stage.ws.close();
  await sleep(300);
  const stageReborn = await connect('receiver', 'Stage', 'PA-01');
  await sleep(250);
  const yourName3 = last(stageReborn, 'yourname');
  check('reconnect restores rename', yourName3 && yourName3.name === 'Auditorium');
  check('reconnect restores mute', yourName3 && yourName3.muted === true);
  roster = last(op3, 'receivers');
  check('roster shows restored name', roster.receivers.some((r) => r.id === 'PA-01' && r.name === 'Auditorium'));
  stageReborn.ws.close();
  op2.ws.close();
  await sleep(200);

  console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('Test crashed:', e.message);
  process.exit(1);
});
