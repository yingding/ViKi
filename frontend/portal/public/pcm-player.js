// PCM Player Worklet for robust playback
// Based on ring buffer implementation to decouple network/main thread jitter from audio rendering

class PcmPlayer extends AudioWorkletProcessor {
    constructor() {
      super();
      this.queue = [];
      this.started = false;
      this.frameCount = 0;
      this.totalSamplesPlayed = 0;

      this.port.onmessage = (e) => {
        if (e.data.cmd === 'start') {
            this.started = true;
            this.port.postMessage({ type: 'debug', msg: 'CMD:Start received. Playing.' });
        } else if (e.data.cmd === 'stop') {
            this.started = false;
            this.queue = [];
            this.totalSamplesPlayed = 0;
            this.port.postMessage({ type: 'debug', msg: 'CMD:Stop received. Queue cleared.' });
        } else if (e.data instanceof Float32Array) {
            this.queue.push(e.data);
            // Log every 10th chunk received
            if (this.queue.length % 10 === 1) {
                this.port.postMessage({ type: 'debug', msg: `Chunk received. QueueSize=${this.queue.length}` });
            }
        }
      };
    }
  
    process(inputs, outputs, parameters) {
      const output = outputs[0];
      if (!output || !output[0]) return true;
      
      const channel0 = output[0];
      const channel1 = output[1]; // For stereo output
      this.frameCount++;
      
      // Queue overflow protection: Drop oldest if queue grows too large (>50 chunks = ~2s)
      const MAX_QUEUE_SIZE = 50;
      while (this.queue.length > MAX_QUEUE_SIZE) {
          this.queue.shift(); // Drop oldest
          this.port.postMessage({ type: 'debug', msg: `Queue overflow! Dropped oldest chunk. Size=${this.queue.length}` });
      }
      
      // Heartbeat: Log every 500 frames (~10 seconds at 128 samples/frame @ 24kHz)
      if (this.frameCount % 500 === 0) {
          this.port.postMessage({ type: 'heartbeat', frame: this.frameCount, queueSize: this.queue.length, started: this.started, played: this.totalSamplesPlayed });
      }
      
      // If not started or empty, output silence
      if (!this.started || this.queue.length === 0) {
          channel0.fill(0);
          if (channel1) channel1.fill(0); // Stereo silence
          return true;
      }
  
      let offset = 0;
      while (offset < channel0.length && this.queue.length > 0) {
          const chunk = this.queue[0];
          const remainingInChunk = chunk.length;
          const spaceInOutput = channel0.length - offset;
          const toCopy = Math.min(remainingInChunk, spaceInOutput);
          
          // Copy samples to both channels (mono -> stereo)
          const samples = chunk.subarray(0, toCopy);
          channel0.set(samples, offset);
          if (channel1) channel1.set(samples, offset); // Duplicate to right channel
          offset += toCopy;
          
          if (toCopy < remainingInChunk) {
              // We only consumed part of the chunk
              this.queue[0] = chunk.subarray(toCopy);
          } else {
              // We consumed the whole chunk
              this.queue.shift();
          }
      }
      
      // Track samples played
      this.totalSamplesPlayed += offset;
      
      // If we ran out of data mid-frame, fill rest with silence (both channels)
      if (offset < channel0.length) {
          channel0.fill(0, offset);
          if (channel1) channel1.fill(0, offset);
      }
      
      return true;
    }
  }
  
  registerProcessor('pcm-player', PcmPlayer);
