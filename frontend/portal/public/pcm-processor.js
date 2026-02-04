class PCMProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const float32Data = input[0];
      
      // CORRECT WAY: Create a copy of the TypedArray data
      // .slice() on the TypedArray creates a new compact Float32Array with just the data
      const float32Copy = float32Data.slice();
      
      // Transfer the buffer of the copy
      this.port.postMessage(float32Copy.buffer, [float32Copy.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
