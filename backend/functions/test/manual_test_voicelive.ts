import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import * as os from 'os';
import { createVoiceLiveSession } from '../src/lib/voiceliveclient';
import type { StoredConsult } from '../src/lib/consultRepository';

// --- Configuration ---
const CONFIG = {
    SAMPLE_RATE: 24000,
    CHANNELS: 1,
    BIT_DEPTH: 16,
    PLAYBACK_BUFFER: 32768, // Larger buffer for smoother playback
    ECHO_MUTE_MS: 300,      // Time to mute mic after playback ends (software AEC)
    VAD_THRESHOLD: 0.7      // Higher threshold to reduce background noise triggers
};

// --- Environment Setup ---
function loadEnv() {
    let localSettingsPath = path.resolve(process.cwd(), 'local.settings.json');
    if (!fs.existsSync(localSettingsPath)) {
        localSettingsPath = path.resolve(process.cwd(), '../local.settings.json');
    }
    console.log(`[Env] Loading settings from: ${localSettingsPath}`);

    if (fs.existsSync(localSettingsPath)) {
        const settings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf8'));
        if (settings.Values) {
            Object.assign(process.env, settings.Values);
            console.log('[Env] Environment variables loaded.');
        }
    } else {
        console.warn("[Env] local.settings.json not found. Ensure environment variables are set.");
    }
}
loadEnv();

// --- Audio Player Class ---
class AudioPlayer {
    private process: child_process.ChildProcessWithoutNullStreams | null = null;
    private isRunning = false;
    private lastWriteTime = 0;
    private predictedEndTime = 0;

    constructor() {}

    start() {
        if (this.isRunning) return;
        
        // Use a smaller buffer to reduce start/stop latency
        // 4096 bytes @ 48000 bytes/sec ~= 85ms latency
        const bufferSize = 4096; 
        
        const args = [
            '--buffer', bufferSize.toString(),
            '-t', 'raw',
            '-r', CONFIG.SAMPLE_RATE.toString(),
            '-c', CONFIG.CHANNELS.toString(),
            '-e', 'signed-integer',
            '-b', CONFIG.BIT_DEPTH.toString(),
            '-' // Read from stdin
        ];

        if (os.platform() === 'win32') {
            args.push('-t', 'waveaudio', 'default');
        } else {
            args.push('-d');
        }

        try {
            this.process = child_process.spawn('sox', args);
            this.isRunning = true;
            console.log(" [Speaker] Started");

            this.process.on('exit', (code) => {
                this.isRunning = false;
                this.process = null;
            });

            this.process.stdin.on('error', () => { /* Prevent crash on pipe error */ });
            this.process.stderr.on('data', (d) => { /* Suppress noisy sox logs */ });

        } catch (e: any) {
            console.error(" [Speaker] Failed to start:", e.message);
        }
    }

    stop() {
        if (this.process) {
            console.log(" [Speaker] Stopping (Barge-in/Reset)...");
            try {
                this.process.stdin.end();  // Close input stream
                this.process.kill();       // Force kill
            } catch (e) {}
            this.process = null;
            this.isRunning = false;
            // When stopped manually (barge-in), clear the predicted end time so mic opens immediately
            this.predictedEndTime = 0; 
        }
    }

    write(data: Uint8Array) {
        if (!this.isRunning || !this.process) {
            this.start();
        }
        if (this.process && this.process.stdin.writable) {
            try {
                this.process.stdin.write(Buffer.from(data));
                this.lastWriteTime = Date.now();
                
                // Calculate duration: bytes / (sampleRate * channels * bytesPerSample)
                // 24000 * 1 * 2 = 48000 bytes/sec
                const durationMs = (data.byteLength / 48000) * 1000;
                
                // Extend the busy window
                const now = Date.now();
                if (this.predictedEndTime < now) {
                    this.predictedEndTime = now + durationMs;
                } else {
                    this.predictedEndTime += durationMs;
                }
                
            } catch (e) {
                // Ignore write errors (process might be dying)
            }
        }
    }

    getPredictedActionEndTime() {
        return this.predictedEndTime;
    }

    getLastWriteTime() {
        return this.lastWriteTime;
    }
}

// --- Audio Recorder Class ---
class AudioRecorder {
    private process: child_process.ChildProcessWithoutNullStreams | null = null;
    
    constructor(private onData: (data: Buffer) => void) {}

    start() {
        const args = [
            '--no-show-progress',
            '--rate', CONFIG.SAMPLE_RATE.toString(),
            '--channels', CONFIG.CHANNELS.toString(),
            '--encoding', 'signed-integer',
            '--bits', CONFIG.BIT_DEPTH.toString(),
            '--type', 'raw',
            '-' // Output to stdout
        ];

        if (os.platform() === 'win32') {
            // Unshift adds multiple elements in order at the start of the array
            // We want: -t waveaudio default
            args.unshift('-t', 'waveaudio', 'default'); 
        } else {
            args.unshift('-d'); // sox -d
        }

        console.log(" [Mic] Starting recording...");
        this.process = child_process.spawn('sox', args);

        this.process.stdout.on('data', (data: Buffer) => {
            this.onData(data);
        });

        this.process.stderr.on('data', () => {}); // Ignore stderr
        this.process.on('error', (e) => console.error(" [Mic] Error:", e));
    }

    stop() {
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
    }
}

// --- Main Test Logic ---
async function runTest() {
    // 1. Check Dependencies
    try {
        child_process.execSync('sox --version', { stdio: 'ignore' });
    } catch {
        console.error("ERROR: 'sox' is not installed or not in PATH.");
        process.exit(1);
    }

    // 2. Mock Data
    const mockConsult: StoredConsult = {
        id: 'test-consult-123',
        convId: 1001,
        msgId: 5001,
        senderEmail: 'test-doctor@example.com',
        receivedAt: new Date().toISOString(),
        payload: { msgId: 5001, convId: 1001, created: Date.now(), msgType: 'text', msgText: "Mock Consult Context", senderEmail: 'test-doctor@example.com' }
    };

    // 3. Components
    const player = new AudioPlayer();
    
    // We need to initialize the session first to get the sender
    console.log('[System] Connecting to VoiceLive...');
    
    try {
        const session = await createVoiceLiveSession(mockConsult, {
            onAudioData: (data) => {
                player.write(data);
            },
            onInputStarted: () => {
                // Server detected user speech (Barge-in)
                // Stop playback immediately to stop the bot from talking over the user
                player.stop();
            }
        }, {
            vadThreshold: CONFIG.VAD_THRESHOLD
        });

        const debugFilePath = path.join(__dirname, 'input_debug.pcm');
        const debugFile = fs.createWriteStream(debugFilePath);

        console.log('[System] Session Connected! ID:', session.sessionId);
        console.log('------------------------------------------------');
        console.log('  Say "Help" or ask a question.');
        console.log('  Press Ctrl+C to exit.');
        console.log(`  Debug: Input audio saved to: ${debugFilePath}`);
        console.log('------------------------------------------------');

        // 4. Input Handling (Mic)
        const recorder = new AudioRecorder((data) => {
            // Save raw input to file for debugging
            debugFile.write(data);

            if (!session.isConnected) return;

            // --- SOFTWARE ECHO CANCELLATION (Strict Half-Duplex with Barge-in) ---
            // If the speaker is busy (playing audio), MUTE THE MIC.
            // We use the predicted end time of the audio buffer + safety margin (for latency/reverb).
            
            const safetyMargin = CONFIG.ECHO_MUTE_MS || 300; 
            const timeLeft = player.getPredictedActionEndTime() - Date.now();
            
            // 1. Calculate RMS to detect loud user speech (Barge-in attempt)
            // This allows the user to "power through" the mute if they speak loudly
            let rms = 0;
            if (data.length > 0) {
                let sum = 0;
                const numSamples = Math.floor(data.length / 2);
                for (let i = 0; i < data.length - 1; i += 2) {
                    const val = data.readInt16LE(i);
                    sum += val * val;
                }
                rms = Math.sqrt(sum / numSamples);
            }

            // 2. Barge-in Logic
            // INCREASED THRESHOLD: 2000 to prevent echo causing false barge-in
            // This helps to Barge-in only on deliberate loud speech.
            const BARGE_IN_RMS_THRESHOLD = 2000; 
            
            if (timeLeft > -safetyMargin) {
                // Speaker is active. Default is MUTE.
                // Check if user is speaking loudly enough to count as barge-in
                if (rms > BARGE_IN_RMS_THRESHOLD) {
                    if (process.env.DEBUG) process.stdout.write('!'); // Bang! Barge-in
                } else {
                    // Muted
                    if (process.env.DEBUG) process.stdout.write('x'); 
                    return;
                }
            }

            // 3. Send to Azure (and visualize)
            // Threshold for "Is Talking" visualization
            const isTalking = rms > 600; 

            if (process.env.DEBUG) {
                process.stdout.write(isTalking ? '🗣️' : '.');
            }
            session.sendAudio(new Uint8Array(data));
        });
        
        recorder.start();
        player.start();

        setInterval(() => {}, 1000); // Keep alive

        // 5. Cleanup
        process.on('SIGINT', async () => {
            console.log('\n[System] Shutting down...');
            recorder.stop();
            player.stop();
            // Force kill any lingering sox
            try { child_process.execSync('taskkill /F /IM sox.exe', { stdio: 'ignore' }); } catch {}
            process.exit(0);
        });
    } catch (e: any) {
        console.error("Fatal Error:", e.message);
    }
}

runTest();
