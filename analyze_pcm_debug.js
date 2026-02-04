
const fs = require('fs');
const path = require('path');

const filePath = path.resolve(__dirname, 'debug_received.pcm');

if (!fs.existsSync(filePath)) {
    console.log("File not found.");
    process.exit(1);
}

const buffer = fs.readFileSync(filePath);
console.log(`File size: ${buffer.length} bytes`);

// Analyze first 1000 samples (2000 bytes)
const int16 = new Int16Array(buffer.buffer, 0, Math.min(buffer.length, 20000) / 2);

let min = 32767;
let max = -32768;
let sum = 0;
let zeroCount = 0;

for (let i = 0; i < int16.length; i++) {
    const val = int16[i];
    if (val < min) min = val;
    if (val > max) max = val;
    sum += Math.abs(val);
    if (val === 0) zeroCount++;
}

const avg = sum / int16.length;

console.log(`Min: ${min}`);
console.log(`Max: ${max}`);
console.log(`Avg Amplitude: ${avg}`);
console.log(`Zero Count: ${zeroCount} / ${int16.length}`);

if (avg < 10) {
    console.log("WARNING: Signal is extremely quiet (near silence).");
} else {
    console.log("Signal strength seems OK.");
}
