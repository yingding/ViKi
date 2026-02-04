import * as fs from 'fs';
import * as path from 'path';
import { createVoiceLiveSession } from '../src/lib/voiceliveclient';
import type { StoredConsult } from '../src/lib/consultRepository';

// Audio output will be saved to a file instead of playing directly.
// Microphone recording will use 'sox' via child_process.

// Load environment variables from local.settings.json
let localSettingsPath = path.resolve(process.cwd(), 'local.settings.json');
if (!fs.existsSync(localSettingsPath)) {
  localSettingsPath = path.resolve(process.cwd(), '../local.settings.json');
}
console.log(`Loading settings from: ${localSettingsPath}`);

if (fs.existsSync(localSettingsPath)) {
  const settings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf8'));
  if (settings.Values) {
    Object.assign(process.env, settings.Values);
    console.log('Environment variables loaded from local.settings.json');
  }
} else {
  console.warn("local.settings.json not found. Ensure environment variables are set.");
}

import * as child_process from 'child_process';
import * as os from 'os';

// Check if SoX is available
function isSoxAvailable(): boolean {
  try {
    child_process.execSync('sox --version', { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

async function runTest() {
  try {
    const mockConsult: StoredConsult = {
      id: 'test-consult-123',
      convId: 1001,
      msgId: 5001,
      senderEmail: 'test-doctor@example.com',
      receivedAt: new Date().toISOString(),
      payload: {
        msgId: 5001,
        convId: 1001,
        created: Date.now(),
        senderEmail: 'test-doctor@example.com',
        msgType: 'TEXT',
        msgText: 'Can you check the weather in Seattle?',
        attachment: null
      }
    };

    // Audio Output - Save to disk
    const testDir = path.join(process.cwd(), 'test');
    if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
    }
    const outputFilePath = path.join(testDir, 'output_audio.pcm');
    const outputStream = fs.createWriteStream(outputFilePath);
    console.log(`Audio output will be saved to: ${outputFilePath}`);
    console.log(`To play raw PCM: ffplay -f s16le -ar 24000 -ac 1 test/output_audio.pcm`);

    // Audio Playback Setup (Full-Duplex)
    let speakerProcess: child_process.ChildProcessWithoutNullStreams | null = null;
    let speakerStdin: any = null;

    // Helper to start the speaker process
    const startSpeaker = () => {
        if (!isSoxAvailable()) return;
        
        // Use short flags matching the working manual command:
        // sox -t raw -r 24000 -e signed-integer -b 16 -c 1 - -t waveaudio default
        // Added --buffer to help with streaming stability
        const playbackArgs = [
          '--buffer', '32768', 
          '-t', 'raw',
          '-r', '24000',
          '-c', '1',
          '-e', 'signed-integer',
          '-b', '16',
          '-', // read from stdin
        ];

        if (os.platform() === 'win32') {
             playbackArgs.push('-t', 'waveaudio', 'default');
        } else {
             playbackArgs.push('-d');
        }

        try {
            if (process.env.DEBUG) console.log(`[Speaker] Spawning: sox ${playbackArgs.join(' ')}`);
            const speaker = child_process.spawn('sox', playbackArgs);
            
            speaker.stderr.on('data', (d) => {
                 const msg = d.toString();
                 if (msg.includes('FAIL') || msg.includes('warn') || process.env.DEBUG) {
                    console.log(`[Speaker Log]: ${msg.trim()}`);
                 }
            });
            speaker.on('exit', (code) => { 
                if (process.env.DEBUG) console.log(`[Speaker] Exited with code ${code}`);
                // Ensure we don't try to write to a closed stream
                if (speakerProcess === speaker) {
                    speakerProcess = null;
                    speakerStdin = null;
                }
            });
            
            speakerProcess = speaker;
            speakerStdin = speaker.stdin;

            // Ensure we handle errors on stdin to prevent crashing
            speakerStdin.on('error', (e: any) => {
                if (process.env.DEBUG) console.log(`[Speaker Stdin Error]: ${e.message}`);
            });

        } catch (e) {
            console.warn("Failed to spawn speaker:", e);
        }
    };
    
    let speakerPredictedEndTime = 0;

    // Initial start
    startSpeaker();

    console.log('Connecting to VoiceLive session...');
    const session = await createVoiceLiveSession(mockConsult, {
        onAudioData: (data) => {
            // Log reception
            if (data.byteLength > 0 && process.env.DEBUG) {
                 process.stdout.write(`.`); 
            }

            // Write to file on audio delta
            outputStream.write(Buffer.from(data));
            
            // Ensure speaker is running (might have been killed by barge-in)
            // Only restart if we have fresh data and previous one is dead or null
            if (data.byteLength > 0 && !speakerProcess) {
                if (process.env.DEBUG) console.log("[Speaker] Restarting/Starting speaker process...");
                startSpeaker();
            }

            // Write to speaker if active
            if (speakerStdin && !speakerStdin.destroyed) {
                try {
                    speakerStdin.write(Buffer.from(data));
                    
                    // Calculate duration of this chunk
                    // 24000 Hz, 16-bit (2 bytes) => 48000 bytes/sec
                    const durationMs = (data.byteLength / 48000) * 1000;
                    
                    const now = Date.now();
                    // If previous audio finished, start counting from now. Otherwise append.
                    if (speakerPredictedEndTime < now) {
                        speakerPredictedEndTime = now;
                    }
                    speakerPredictedEndTime += durationMs;

                } catch (err) { 
                    console.warn("Error writing to speaker:", err);
                }
            }
        },
        onInputStarted: () => {
             // Barge-in detected: Stop playback immediately
             if (speakerProcess && speakerProcess.exitCode === null) {
                 console.log("\n[Barge-in] User started speaking. Stopping playback.");
                 
                 // Prevent future writes and suppress errors on current stdin
                 if (speakerStdin) {
                     speakerStdin.removeAllListeners('error');
                     speakerStdin.on('error', () => {}); 
                     // speakerStdin = null; // Do not nullify to allow stream to continue if we don't kill
                 }
                 
                 try {
                     speakerProcess.kill(); 
                 } catch(e) {}
             }
        }
    });
    console.log('Session created successfully!');
    console.log('Session created successfully!');
    console.log('Session ID:', session.sessionId);
    console.log('Connection State:', session.connectionState);

    // Audio Recording Setup
    let recordingProcess: child_process.ChildProcessWithoutNullStreams | null = null;

    if (!isSoxAvailable()) {
         console.warn("\nWARNING: 'sox' command not found in PATH.");
         console.warn("Microphone recording will be DISABLED.\n");
    } else {
        console.log('Starting microphone recording (PCM 16-bit, 24kHz)...');
        
        // Construct arguments for raw PCM 24kHz 16-bit Mono output to stdout
        const soxArgs = [
          '--no-show-progress',
          '--rate', '24000',
          '--channels', '1',
          '--encoding', 'signed-integer',
          '--bits', '16',
          '--type', 'raw',
          '-' // Output to stdout
        ];

        // Platform-specific input device arguments
        if (os.platform() === 'win32') {
            // "sox -t waveaudio default ..." works best on Windows
            soxArgs.unshift('default'); 
            soxArgs.unshift('waveaudio');
            soxArgs.unshift('-t');
        } else {
            // "sox -d ..." works on Mac/Linux
            soxArgs.unshift('-d');
        }

        console.log(`Spawning sox: sox ${soxArgs.join(' ')}`);

        try {
            let totalBytes = 0;
            recordingProcess = child_process.spawn('sox', soxArgs);

            let lastLogTime = 0;
            recordingProcess.stdout.on('data', (data: Buffer) => {
               if (session.isConnected) {
                  // Heartbeat logging every 2 seconds
                  const now = Date.now();
                  if (now - lastLogTime > 2000 && process.env.DEBUG) {
                      process.stdout.write(`\r[Mic Active] Sending ${data.length} bytes... `);
                      lastLogTime = now;
                  }

                  // Check for silence (all zeros) to debug permission issues
                  let isSilence = true;
                  for (let i = 0; i < data.length; i+=100) { // Check sample every 100 bytes
                      if (data[i] !== 0) { isSilence = false; break; }
                  }
                  if (isSilence && Math.random() < 0.05) { // Log occasionally
                      console.log('[Audio] Warning: Input seems to be silence (0 bytes). Check microphone permissions.');
                  }

                  // HALF-DUPLEX: Mute microphone while speaker is active to prevent echo/feedback loop
                  // We calculate the predicted end time of the audio queue.
                  // Add a 500ms safety buffer for system latency.
                  if (Date.now() < speakerPredictedEndTime + 500) {
                      // Discard audio while bot is speaking
                      return;
                  }

                  session.sendAudio(new Uint8Array(data));
                  totalBytes += data.length;
                  // Removed the per-packet debug write to reduce noise, relying on heartbeat
               } else {
                   if (Math.random() < 0.01) console.warn("\n[Warning] Session not connected! Audio data dropped.");
               }
            });

            recordingProcess.stderr.on('data', (data: Buffer) => {
                const msg = data.toString();
                // Filter out common info/status unless debug is on
                if (process.env.DEBUG || msg.includes('FAIL') || msg.includes('WARN')) {
                   console.warn(`[sox]: ${msg.trim()}`);
                }
            });

            recordingProcess.on('error', (err: any) => {
               console.warn("\nMicrophone process error:", err.message || err);
               console.warn("Audio recording stopped. Continuing in text-only mode.\n"); 
            });

        } catch (err: any) {
           console.warn("Failed to spawn recording process:", err);
        }
    }

    // Text Input Setup
    process.stdin.setEncoding('utf8');
    const onData = async (input: string) => {
        const text = input.trim();
        if (text) {
             if (!session.isConnected) {
                 console.log("Session is not connected. Cannot send text.");
                 return;
             }
             console.log(`Sending text: "${text}"`);
             try {
                await session.addConversationItem({
                    type: "message", 
                    role: "user",
                    content: [{ type: "input_text", text: text }]
                } as any);
                await session.sendEvent({ type: "response.create" });
             } catch (err) {
                 console.error("Error sending text:", err);
             }
        }
    };
    process.stdin.on('data', onData);

    // Keep interaction alive
    console.log('Test running. You can type text messages and press Enter, or use Microphone if enabled.');
    console.log('Press Ctrl+C to stop.');

    process.stdin.resume(); // Keep process alive

    await new Promise((resolve) => {
        // Run until manually stopped
        process.on('SIGINT', () => {
            console.log('\nStopping...');
            process.stdin.off('data', onData); // Stop listening to input
            process.stdin.pause();
            if (recordingProcess) {
                try { recordingProcess.kill(); } catch (e) { /* ignore cleanup errors */ }
            }
            if (speakerProcess) {
                try { speakerProcess.kill(); } catch (e) { /* ignore cleanup errors */ }
            }
            resolve(true); 
        });
    });

    // Clean up
    if (session.isConnected) {
        await session.dispose();
        console.log('Session disposed.');
    }
    
    process.exit(0);

  } catch (error) {
    console.error('Test Failed:', error);
    process.exit(1);
  }
}

runTest();
