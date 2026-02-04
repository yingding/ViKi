const fs = require('fs');

try {
    const buffer = fs.readFileSync('debug_received.pcm');
    const int16 = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
    
    let min = 0;
    let max = 0;
    let sumSq = 0;
    
    for(let i=0; i<int16.length; i++) {
        const val = int16[i];
        if (val < min) min = val;
        if (val > max) max = val;
        sumSq += val * val;
    }
    
    const rms = Math.sqrt(sumSq / int16.length);
    
    console.log(`Analyzing debug_received.pcm (${int16.length} samples)`);
    console.log(`Min: ${min}`);
    console.log(`Max: ${max}`);
    console.log(`RMS: ${rms.toFixed(2)}`);
    
    if (rms < 100) {
        console.log("WARNING: Audio is suspiciously quiet (Silence).");
    } else {
        console.log("Audio signal detected.");
    }

} catch(e) {
    console.error("Failed to read file:", e.message);
}