class MicFrames extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(400);
    this.used = 0;
  }
  process(inputs) {
    for (const sample of inputs[0]?.[0] || []) {
      this.samples[this.used++] = Math.round(Math.max(-1, Math.min(0.99997, sample)) * 32768);
      if (this.used === this.samples.length) {
        this.port.postMessage(this.samples);
        this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor('mic-frames', MicFrames);
