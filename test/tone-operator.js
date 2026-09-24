// Fake operator: connects, presses talk, streams a 440 Hz tone for N seconds.
'use strict';
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const DURATION = Number(process.argv[2] || 3);
const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
ws.binaryType = 'nodebuffer';

ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'operator', name: 'tone-test' })));

ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  const msg = JSON.parse(data.toString());
  if (msg.type === 'welcome') {
    console.log('operator ready; talking for', DURATION, 's');
    ws.send(JSON.stringify({ type: 'talk_start' }));
    const rate = 24000;
    const frameSamples = 960; // 40 ms
    const framesTotal = Math.round((DURATION * rate) / frameSamples);
    let f = 0;
    const timer = setInterval(() => {
      if (f >= framesTotal) {
        clearInterval(timer);
        ws.send(JSON.stringify({ type: 'talk_stop' }));
        console.log('done; frames sent:', framesTotal);
        setTimeout(() => process.exit(0), 300);
        return;
      }
      const buf = Buffer.alloc(frameSamples * 2);
      for (let i = 0; i < frameSamples; i++) {
        const t = ((f * frameSamples) + i) / rate;
        const v = Math.sin(2 * Math.PI * 440 * t) * 0.4;
        buf.writeInt16LE(Math.round(v * 32767), i * 2);
      }
      ws.send(buf);
      f++;
    }, 40);
  }
});
