// Capture worklet: accumulates mic samples, resamples to 24 kHz mono,
// converts to Int16 and posts 40 ms frames to the main thread.
// If the AudioContext already runs at 24 kHz the decimator is a no-op;
// otherwise a one-pole low-pass is applied before decimation.
class PttCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const targetRate = (options.processorOptions && options.processorOptions.targetRate) || 24000;
    this.frameSize = 960; // 40 ms at 24 kHz
    this.factor = Math.max(1, Math.round(sampleRate / targetRate));
    this.acc = new Float32Array(this.frameSize * this.factor);
    this.accLen = 0;
    this.lp = 0;
    // ~8 kHz corner, safe under the 24 kHz Nyquist
    this.alpha = Math.min(1, 1 - Math.exp((-2 * Math.PI * 8000) / sampleRate));
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      this.lp += this.alpha * (input[i] - this.lp);
      this.acc[this.accLen++] = this.lp;
      if (this.accLen === this.acc.length) {
        const n = this.frameSize;
        const buf = new Int16Array(n);
        let sum = 0;
        for (let j = 0; j < n; j++) {
          let s = this.acc[j * this.factor];
          if (s > 1) s = 1;
          else if (s < -1) s = -1;
          buf[j] = s < 0 ? s * 32768 : s * 32767;
          sum += s * s;
        }
        const rms = Math.sqrt(sum / n);
        this.port.postMessage({ type: 'chunk', rms, chunk: buf }, [buf.buffer]);
        this.accLen = 0;
      }
    }
    return true;
  }
}

registerProcessor('ptt-capture', PttCapture);
