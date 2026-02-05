"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE_URL } from '../lib/config';

type Props = {
  consultId?: string;
  isOffline?: boolean;
};

type VoiceStatus = 'idle' | 'connecting' | 'live' | 'error';

function base64ToUint8Array(base64: string) {
    const binaryString = window.atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}


class ReorderBuffer {
    private expected = 1; // Backend starts at 1
    private pending = new Map<number, Float32Array>();
    private initialized = false; // Track if we've seen the first packet
    
    push(seq: number, data: Float32Array) {
        // Auto-initialize expected from first packet to avoid deadlock
        if (!this.initialized) {
            this.expected = seq;
            this.initialized = true;
            console.log(`[ReorderBuffer] Auto-initialized expected to ${seq} from first packet`);
        }
        this.pending.set(seq, data);
        console.log(`[ReorderBuffer] Push S=${seq}. Expected=${this.expected}. Pending=${this.pending.size}`);
    }
    
    popReady(): Float32Array[] {
        const out: Float32Array[] = []; 
        while (this.pending.has(this.expected)) {
            out.push(this.pending.get(this.expected)!);
            this.pending.delete(this.expected);
            this.expected += 1;
        }
        if (out.length > 0) {
            console.log(`[ReorderBuffer] Popped ${out.length} chunks. NewExpected=${this.expected}`);
        }
        return out;
    }
    
    // Resync: Jump to a new sequence if we're too far behind
    resync(newSeq: number) {
        console.log(`[ReorderBuffer] RESYNC: Jumping from expected=${this.expected} to ${newSeq}`);
        this.expected = newSeq;
    }
    
    // Flush: Return all pending chunks regardless of order (for emergency playback)
    flush(): Float32Array[] {
        const out: Float32Array[] = [];
        // Sort by sequence and return all
        const sorted = Array.from(this.pending.entries()).sort((a, b) => a[0] - b[0]);
        for (const [seq, data] of sorted) {
            out.push(data);
        }
        if (out.length > 0) {
            console.log(`[ReorderBuffer] FLUSH: Returning ${out.length} chunks out-of-order`);
            // Update expected to highest + 1
            const maxSeq = sorted[sorted.length - 1]?.[0] ?? this.expected;
            this.expected = maxSeq + 1;
        }
        this.pending.clear();
        return out;
    }
    
    getExpected() { return this.expected; }
    getPendingSize() { return this.pending.size; }
    
    reset() {
        console.log(`[ReorderBuffer] RESET`);
        this.expected = 1;
        this.initialized = false;
        this.pending.clear();
    }
}

export function VoiceConsole({ consultId, isOffline = false }: Props) {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [incomingVolume, setIncomingVolume] = useState<number>(0);
  const [micVolume, setMicVolume] = useState<number>(0);
  const [debugLog, setDebugLog] = useState<string>("Ready"); 
  const [rxCount, setRxCount] = useState<number>(0);
  const [showDebug, setShowDebug] = useState<boolean>(false);

  // Audio Processing Refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<AudioNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const isPendingStopRef = useRef<boolean>(false);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const serverReadyRef = useRef<boolean>(false);
  const reorderBufferRef = useRef<ReorderBuffer>(new ReorderBuffer());
  const playerNodeRef = useRef<AudioWorkletNode | null>(null);
  const bufferedSamplesRef = useRef<number>(0);
  const isPlayingRef = useRef<boolean>(false);
  const earlyChunkQueueRef = useRef<{seq: number, data: Float32Array}[]>([]); // Queue for chunks arriving before worklet ready
  
  // Analyser Refs
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Noise Floor Calibration Refs
  const noiseFloorRef = useRef<number>(0.001); // Default noise floor (will be calibrated)
  const calibrationSamplesRef = useRef<number[]>([]); // Collect samples for calibration
  const isCalibrationDoneRef = useRef<boolean>(false);
  const dcOffsetRef = useRef<number>(0); // Track DC offset for high-pass filter

  // Session Management Refs (for clean restart)
  const abortControllerRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<number>(0); // Increment on each start to ignore stale events
  const downlinkReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);

  // Meter-specific refs (visual only, independent of audio processing)
  const micMeterFloorRef = useRef<number>(0.0005); // Lower floor for visual (separate from audio gate)
  const lastIncomingActivityRef = useRef<number>(0); // Timestamp of last significant incoming audio

  const stopPlayback = useCallback((ctx: AudioContext) => {
    console.log("[VoiceConsole] Interrupt! Stopping playback (Barge-in)");
    
    // Clear legacy nodes
    activeSourcesRef.current.forEach(node => {
        try { node.stop(); } catch(e) {}
    });
    activeSourcesRef.current = [];

    // Clear Worklet
    if (playerNodeRef.current) {
        playerNodeRef.current.port.postMessage({ cmd: 'stop' });
    }
    bufferedSamplesRef.current = 0;
    isPlayingRef.current = false;
    reorderBufferRef.current.reset();

    // Reset Start Time to now so new audio plays immediately
    nextStartTimeRef.current = ctx.currentTime;
  }, []);

  const cleanup = useCallback(() => {
    isPendingStopRef.current = true;
    
    // Abort downlink fetch and cancel reader to prevent stale error messages
    if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
    }
    if (downlinkReaderRef.current) {
        downlinkReaderRef.current.cancel().catch(() => {});
        downlinkReaderRef.current = null;
    }
    
    // Reset session-scoped refs
    serverReadyRef.current = false;
    earlyChunkQueueRef.current = [];
    
    if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
    }

    if (playerNodeRef.current) {
        playerNodeRef.current.disconnect();
        playerNodeRef.current = null;
    }
    
    if (audioContextRef.current) {
        // We can't use stopPlayback here directly if ctx is null/closed, 
        // but manually cleaning sources is good practice
        activeSourcesRef.current.forEach(node => {
            try { node.stop(); } catch(e) {}
        });
        activeSourcesRef.current = [];
    }

    if (processorRef.current) {
        processorRef.current.disconnect();
        processorRef.current = null;
    }
    
    if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
    }

    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => {});
        audioContextRef.current = null;
    }
    
    setStatus('idle');
    setMicVolume(0);
    setIncomingVolume(0);
  }, []);

  useEffect(() => {
     return () => cleanup();
  }, [cleanup]);

  useEffect(() => {
    if (!consultId && status !== 'idle') {
      cleanup();
    }
  }, [consultId, status, cleanup]);

  const testAudio = () => {
    try {
        if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
            const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
            audioContextRef.current = new AudioContextClass({ sampleRate: 24000 });
        }
        const ctx = audioContextRef.current;
        if (ctx.state === 'suspended') ctx.resume();
        
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
        
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.5);
        setDebugLog("Test Tone Played");
    } catch(e: any) {
        setDebugLog("Test Tone Err: " + e.message);
    }
  };

  const playAudioChunk = (data: Uint8Array, ctx: AudioContext, seq: number) => {
      // Safety: Resume AudioContext if suspended (browser autoplay policy)
      if (ctx.state === 'closed') {
          console.warn(`[VoiceConsole] AudioContext is CLOSED. Cannot play S=${seq}.`);
          return;
      }
      if (ctx.state === 'suspended') {
          console.log(`[VoiceConsole] AudioContext SUSPENDED. Resuming...`);
          ctx.resume().catch(e => console.warn("Resume failed", e));
      }

      // Decode Int16 -> Float32 with SOFT LIMITER (no hard clipping)
      const bufferCopy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const int16 = new Int16Array(bufferCopy);
      
      const float32 = new Float32Array(int16.length);
      const PLAYBACK_GAIN = 1.0; // Reduced from 1.2 to avoid distortion
      
      // Soft limiter function (tanh-based) - preserves dynamics without harsh clipping
      const softLimit = (x: number) => Math.tanh(x * 1.5) / Math.tanh(1.5);
      
      let sumSq = 0;
      for (let i = 0; i < int16.length; i++) {
          const raw = (int16[i] / 32768.0) * PLAYBACK_GAIN;
          float32[i] = softLimit(raw); // Soft limit instead of hard clamp
          sumSq += float32[i] * float32[i];
      }
      
      const rms = Math.sqrt(sumSq / int16.length);
      const rb = reorderBufferRef.current;
      
      console.log(`[VoiceConsole] RX Chunk: S=${seq}, Bytes=${data.length}, RMS=${rms.toFixed(4)}, Expected=${rb.getExpected()}, Buffered=${bufferedSamplesRef.current}, Playing=${isPlayingRef.current}`);
      setDebugLog(`S=${seq} | Exp=${rb.getExpected()} | Buf=${bufferedSamplesRef.current} | Play=${isPlayingRef.current}`);

      try {
        const node = playerNodeRef.current;
        
        // If Worklet not ready yet, queue for later
        if (!node) {
            console.log(`[VoiceConsole] Worklet NOT READY. Queuing S=${seq} for later.`);
            earlyChunkQueueRef.current.push({ seq, data: float32 });
            return;
        }
        
        // RESYNC CHECK: If incoming seq is way ahead of expected, resync
        const GAP_THRESHOLD = 10;
        if (seq > rb.getExpected() + GAP_THRESHOLD) {
            console.warn(`[VoiceConsole] Large gap detected! S=${seq} vs Expected=${rb.getExpected()}. Resyncing.`);
            rb.resync(seq);
        }
        
        // Push to ReorderBuffer
        rb.push(seq, float32);
        
        // FLUSH CHECK: If too many pending, flush to avoid stall
        const MAX_PENDING = 20;
        let readyChunks: Float32Array[];
        if (rb.getPendingSize() > MAX_PENDING) {
            console.warn(`[VoiceConsole] Pending buffer overflow (${rb.getPendingSize()}). Flushing.`);
            readyChunks = rb.flush();
        } else {
            readyChunks = rb.popReady();
        }
        
        // Send ready chunks to Worklet
        if (readyChunks.length > 0) {
            readyChunks.forEach(chunk => {
                // Clone buffer before transfer (transfer detaches the original)
                const clone = new Float32Array(chunk);
                node.port.postMessage(clone, [clone.buffer]);
                bufferedSamplesRef.current += chunk.length;
            });
            console.log(`[VoiceConsole] Sent ${readyChunks.length} chunks to Worklet. TotalBuffered=${bufferedSamplesRef.current}`);
        }
        
        // Pre-roll / Warm-up: Wait for ~300ms (7200 samples) before starting playback
        // This prevents chopped beginnings by ensuring buffer is primed
        const TARGET_LATENCY_SAMPLES = 24000 * 0.3; // 300ms pre-roll
        
        if (!isPlayingRef.current && bufferedSamplesRef.current >= TARGET_LATENCY_SAMPLES) {
            console.log(`[VoiceConsole] Pre-roll complete (${bufferedSamplesRef.current}/${TARGET_LATENCY_SAMPLES}). Sending START command.`);
            node.port.postMessage({ cmd: 'start' });
            isPlayingRef.current = true;
        }
      } catch (e) {
          console.warn("[VoiceConsole] Playback error:", e);
      }
  };

  const startSession = async () => {
    if (!consultId) return;
    
    console.log(`[VoiceConsole] Starting session for consult: ${consultId}`);
    setStatus('connecting');
    setError(null);
    isPendingStopRef.current = false;
    activeSourcesRef.current = [];
    
    // Increment session ID to invalidate any stale downlink handlers
    sessionIdRef.current += 1;
    const currentSessionId = sessionIdRef.current;
    console.log(`[VoiceConsole] Session ID: ${currentSessionId}`);
    
    // Reset server ready state for new session
    serverReadyRef.current = false;
    earlyChunkQueueRef.current = [];


    try {
        // 1. Setup AudioContext (request 24kHz for compatibility)
        console.log("[VoiceConsole] Initializing AudioContext (24kHz)...");
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        const ctx = new AudioContextClass({ sampleRate: 24000 });
        audioContextRef.current = ctx;
        nextStartTimeRef.current = ctx.currentTime;
        
        // Log actual sample rate for debugging
        console.log(`[VoiceConsole] AudioContext actual sampleRate: ${ctx.sampleRate}Hz, state: ${ctx.state}`);
        
        // Setup Analyser
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyserRef.current = analyser;
        analyser.connect(ctx.destination);

        // Setup AudioWorklet Node (Jitter Buffer)
        try {
            console.log("[VoiceConsole] Loading PCM Player Worklet...");
            await ctx.audioWorklet.addModule('/pcm-player.js');
            const playerNode = new AudioWorkletNode(ctx, 'pcm-player');
            playerNode.port.onmessage = (e) => {
                 if (e.data.type === 'debug') console.log("[Worklet]", e.data.msg);
                 if (e.data.type === 'heartbeat') console.log(`[Worklet Heartbeat] Frame=${e.data.frame}, QueueSize=${e.data.queueSize}, Started=${e.data.started}, Played=${e.data.played}`);
            };
            playerNode.connect(analyser);
            playerNodeRef.current = playerNode;
            reorderBufferRef.current.reset();
            bufferedSamplesRef.current = 0;
            isPlayingRef.current = false;
            
            // Flush any early chunks that arrived before worklet was ready
            if (earlyChunkQueueRef.current.length > 0) {
                console.log(`[VoiceConsole] Flushing ${earlyChunkQueueRef.current.length} early chunks to worklet...`);
                earlyChunkQueueRef.current.forEach(({ seq, data }) => {
                    reorderBufferRef.current.push(seq, data);
                });
                const readyChunks = reorderBufferRef.current.popReady();
                readyChunks.forEach(chunk => {
                    const clone = new Float32Array(chunk);
                    playerNode.port.postMessage(clone, [clone.buffer]);
                    bufferedSamplesRef.current += chunk.length;
                });
                earlyChunkQueueRef.current = [];
                console.log(`[VoiceConsole] Early chunk flush complete. Buffered=${bufferedSamplesRef.current}`);
            }
        } catch (e) {
            console.error("[VoiceConsole] Worklet load failed:", e);
        }
        
        // Start Analysis Loop
        const updateVisuals = () => {
             if (status === 'error' || isPendingStopRef.current || !analyserRef.current) return;
             
             const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
             analyserRef.current.getByteTimeDomainData(dataArray);
             
             // Calculate RMS with DC removal
             let sum = 0;
             let dcSum = 0;
             for(let i = 0; i < dataArray.length; i++) {
                 const float = (dataArray[i] - 128) / 128.0; 
                 dcSum += float;
             }
             const dcOffset = dcSum / dataArray.length;
             for(let i = 0; i < dataArray.length; i++) {
                 const float = (dataArray[i] - 128) / 128.0 - dcOffset; // Remove DC
                 sum += float * float;
             }
             const rms = Math.sqrt(sum / dataArray.length);
             
             // Incoming meter: Normalized to target RMS for consistent visual
             // Target ~0.1 RMS for full meter, with activity-based decay
             const INCOMING_TARGET_RMS = 0.08;
             const now = Date.now();
             if (rms > 0.005) {
                 lastIncomingActivityRef.current = now;
             }
             const timeSinceActivity = now - lastIncomingActivityRef.current;
             const activityDecay = timeSinceActivity > 200 ? Math.max(0, 1 - (timeSinceActivity - 200) / 300) : 1;
             const normalizedIncoming = Math.min(100, (rms / INCOMING_TARGET_RMS) * 100 * activityDecay);
             setIncomingVolume(v => v * 0.7 + normalizedIncoming * 0.3);
             
             animationFrameRef.current = requestAnimationFrame(updateVisuals);
        };
        animationFrameRef.current = requestAnimationFrame(updateVisuals);

        console.log(`[VoiceConsole] AudioContext created. State: ${ctx.state}`);

        // Load AudioWorklet Module
        try {
            console.log("[VoiceConsole] Loading AudioWorklet module...");
            await ctx.audioWorklet.addModule('/pcm-processor.js');
            console.log("[VoiceConsole] AudioWorklet loaded successfully.");
        } catch (e) {
            console.warn("[VoiceConsole] Failed to load worklet", e);
            throw new Error("AudioWorklet support required");
        }
        
        // Start Mic immediately (visual feedback + user gesture context)
        await startMic(ctx);

        // Start Downlink (Non-blocking await? No, we await connection init but stream is async)
        await connectDownlink(ctx, currentSessionId);
        
    } catch (err: any) {
        console.error("[VoiceConsole] Session Error:", err);
        setError(err.message || 'Error starting session');
        cleanup();
    }
  };

  const startMic = async (ctx: AudioContext) => {
        // 2. Get Microphone Stream
        console.log("[VoiceConsole] Requesting microphone access...");
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error("Microphone access not supported");
        }
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                // DISABLED browser processing - we handle gain ourselves
                // This gives VoiceLive cleaner audio to interpret
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                sampleRate: 24000 
            } 
        });
        console.log("[VoiceConsole] Microphone stream obtained.");
        
        // Log actual track settings for debugging sample rate issues
        const audioTrack = stream.getAudioTracks()[0];
        const trackSettings = audioTrack.getSettings();
        console.log(`[VoiceConsole] Mic Track Settings: sampleRate=${trackSettings.sampleRate}, channelCount=${trackSettings.channelCount}`);
        
        mediaStreamRef.current = stream;

        const source = ctx.createMediaStreamSource(stream);
        const workletNode = new AudioWorkletNode(ctx, 'pcm-processor');
        processorRef.current = workletNode;

        // Create a silent sink to keep the worklet running without loopback to speakers
        const silentGain = ctx.createGain();
        silentGain.gain.value = 0;

        source.connect(workletNode);
        workletNode.connect(silentGain);
        silentGain.connect(ctx.destination); 
        console.log("[VoiceConsole] Audio graph connected (Loopback muted).");

        // 3. Create Request Stream Processing Loop
        const CHUNK_SIZE_MS = 100; // Reduced from 250ms for lower latency
        const SAMPLE_RATE = 24000; 
        const BYTES_PER_SAMPLE = 2; // Int16
        const BUFFER_SIZE = (SAMPLE_RATE * CHUNK_SIZE_MS) / 1000 * BYTES_PER_SAMPLE; 
        const BASE_GAIN = 3.0; // Increased base gain for stronger VoiceLive input
        const MIN_GAIN = 1.5; // Raised minimum to ensure audible signal
        const MAX_GAIN = 6.0; // Allow higher gain for quiet mics
        const TARGET_RMS = 0.10; // Higher target RMS for better VoiceLive recognition
        let adaptiveGain = BASE_GAIN;
        
        // Soft limiter function (tanh-based) - preserves dynamics without harsh clipping
        const softLimit = (x: number) => Math.tanh(x * 1.5) / Math.tanh(1.5);
        
        // High-pass filter coefficient (removes DC offset and very low frequencies)
        const HP_ALPHA = 0.997; // Slightly higher to preserve low-frequency energy (~20Hz cutoff)
        let hpPrevInput = 0;
        let hpPrevOutput = 0;
        
        // Reset calibration for new session
        isCalibrationDoneRef.current = false;
        calibrationSamplesRef.current = [];
        noiseFloorRef.current = 0.001;
        dcOffsetRef.current = 0;
        const CALIBRATION_DURATION_MS = 2000; // Calibrate noise floor for first 2 seconds
        const calibrationStartTime = Date.now();

        let pcmBuffer = new Uint8Array(0);
        let uploadQueue = Promise.resolve();

        workletNode.port.onmessage = (event) => {
            if (status === 'error' || isPendingStopRef.current) return;
            // Float32 -> Int16 conversion
            const float32 = new Float32Array(event.data);
            
            // Apply high-pass filter to remove DC offset (prevents stuck meter)
            const filtered = new Float32Array(float32.length);
            for (let i = 0; i < float32.length; i++) {
                // DC-blocking high-pass filter: y[n] = alpha * (y[n-1] + x[n] - x[n-1])
                const input = float32[i];
                hpPrevOutput = HP_ALPHA * (hpPrevOutput + input - hpPrevInput);
                hpPrevInput = input;
                filtered[i] = hpPrevOutput;
            }
            
            // Calculate RMS from FILTERED signal
            let sumSq = 0;
            for (let i = 0; i < filtered.length; i++) {
                sumSq += filtered[i] * filtered[i];
            }
            const rms = Math.sqrt(sumSq / filtered.length);
            
            // Noise floor calibration during first 2 seconds
            const timeSinceStart = Date.now() - calibrationStartTime;
            if (!isCalibrationDoneRef.current && timeSinceStart < CALIBRATION_DURATION_MS) {
                calibrationSamplesRef.current.push(rms);
                if (calibrationSamplesRef.current.length > 5) {
                    // Use 20th percentile with reduced margin (less aggressive gating)
                    const sorted = [...calibrationSamplesRef.current].sort((a, b) => a - b);
                    noiseFloorRef.current = sorted[Math.floor(sorted.length * 0.2)] * 1.2; // 20th percentile + small margin
                }
                setDebugLog(`Calibrating... ${Math.ceil((CALIBRATION_DURATION_MS - timeSinceStart) / 1000)}s`);
            } else if (!isCalibrationDoneRef.current) {
                isCalibrationDoneRef.current = true;
                console.log(`[VoiceConsole] Noise floor calibrated: ${noiseFloorRef.current.toFixed(5)}`);
                setDebugLog(`Noise floor: ${noiseFloorRef.current.toFixed(5)}`);
            }
            
            // Relaxed noise gate threshold (1.0x noise floor instead of 1.2x)
            const NOISE_GATE_THRESHOLD = Math.max(0.0005, noiseFloorRef.current * 1.0);
            const isSilence = rms < NOISE_GATE_THRESHOLD;
            
            // Note: Attack/release should be implemented in a stateful manner
            // For now, we just use a very low threshold to avoid cutting speech
            
            // LOCAL BARGE-IN: If mic RMS is high while playing, stop playback immediately
            const BARGE_IN_THRESHOLD = 0.02; // Detect speech
            if (isPlayingRef.current && rms > BARGE_IN_THRESHOLD && audioContextRef.current) {
                console.log(`[VoiceConsole] LOCAL BARGE-IN detected (RMS=${rms.toFixed(4)}). Stopping playback.`);
                stopPlayback(audioContextRef.current);
            }

            // Adaptive gain: adjust gain to target RMS when speech is detected
            if (!isSilence && isCalibrationDoneRef.current) {
                const adjustedRms = Math.max(0, rms - noiseFloorRef.current);
                if (adjustedRms > 0.002) { // Lower threshold to allow gain increase for quiet mics
                    const targetGain = TARGET_RMS / adjustedRms;
                    // Faster adaptation (0.15 blend) for more responsive gain
                    adaptiveGain = adaptiveGain * 0.85 + Math.min(MAX_GAIN, Math.max(MIN_GAIN, targetGain)) * 0.15;
                }
            }

            const int16 = new Int16Array(filtered.length);
            for (let i = 0; i < filtered.length; i++) {
                // Apply adaptive gain with SOFT LIMITER (no hard clipping)
                const sample = isSilence ? 0 : filtered[i];
                const amplified = sample * adaptiveGain;
                const limited = softLimit(amplified); // Soft limit instead of hard clamp
                int16[i] = limited < 0 ? limited * 0x8000 : limited * 0x7FFF;
            }

            const newBuffer = new Uint8Array(pcmBuffer.length + int16.byteLength);
            newBuffer.set(pcmBuffer);
            newBuffer.set(new Uint8Array(int16.buffer), pcmBuffer.length);
            pcmBuffer = newBuffer;

            // Visual Mic Volume - use RAW RMS (before gate) for responsive visual feedback
            // This is separate from audio processing to ensure meter responds to speech
            const micMeterFloor = micMeterFloorRef.current;
            // Gradually adapt meter floor during calibration (visual only)
            if (!isCalibrationDoneRef.current && calibrationSamplesRef.current.length > 3) {
                const sorted = [...calibrationSamplesRef.current].sort((a, b) => a - b);
                micMeterFloorRef.current = sorted[Math.floor(sorted.length * 0.1)] * 1.1; // 10th percentile + small margin
            }
            const meterRms = Math.max(0, rms - micMeterFloor);
            // Scale: target ~0.05 RMS for full meter (speech typically 0.02-0.1 RMS)
            const MIC_METER_TARGET = 0.04;
            const normalizedMicMeter = Math.min(100, (meterRms / MIC_METER_TARGET) * 100);
            setMicVolume(v => v * 0.75 + normalizedMicMeter * 0.25); // Responsive 75/25 blend

            if (pcmBuffer.length >= BUFFER_SIZE) {
                // FIX: Don't drop data while waiting for connection
                if (!serverReadyRef.current) {
                    setDebugLog(`Buffering (${pcmBuffer.length})...`);
                    // Cap buffer to ~256KB (approx 5 seconds) to avoid sending stale audio
                    if (pcmBuffer.length > 256 * 1024) {
                         pcmBuffer = pcmBuffer.slice(BUFFER_SIZE); // Drop oldest frame
                    }
                    return;
                }

                const chunkToSend = pcmBuffer.slice(0, BUFFER_SIZE);
                pcmBuffer = pcmBuffer.slice(BUFFER_SIZE);
                
                // Only upload if server is ready
                if (serverReadyRef.current) {
                    setDebugLog(`Uploading ${chunkToSend.length} bytes...`);
                    // Upload chunk SEQUENTIALLY
                    uploadQueue = uploadQueue.then(() => 
                        fetch(`${API_BASE_URL}/consults/${consultId}/voice-send`, {
                            method: 'POST',
                            body: chunkToSend,
                            headers: { 'Content-Type': 'application/octet-stream' }
                        }).then(res => {
                            if (!res.ok) {
                                setDebugLog(`Upload FAIL: ${res.status}`);
                                console.warn(`[VoiceConsole] Upload failed: ${res.status}`);
                            } else {
                                setDebugLog(`Upload OK: ${res.status} [${Date.now() % 10000}]`);
                            }
                        })
                    ).catch(e => {
                        setDebugLog(`Upload ERR: ${e.message}`);
                        console.warn("[VoiceConsole] Upload error", e);
                    });
                } else {
                    setDebugLog(`Buffering (Wait Ready)... ${pcmBuffer.length}/${BUFFER_SIZE}`);
                }
            }
        };
  };

  const connectDownlink = async (ctx: AudioContext, sessionId: number) => {
        // 4. Start Listen Stream (Downlink)
        const listenUrl = `${API_BASE_URL}/consults/${consultId}/voice-listen`;
        console.log(`[VoiceConsole] Connecting to downlink: ${listenUrl} (Session ${sessionId})`);
        
        setStatus('live');

        // Create AbortController for this session
        const abortController = new AbortController();
        abortControllerRef.current = abortController;

        // Execute Listen in background
        const listenUrlParams = listenUrl + '?_t=' + Date.now();
        
        // Safety Fallback: If connect hangs, enable upload anyway after 2 seconds
        // (Reduced from 6s to help with buffering issues)
        setTimeout(() => {
            if (!serverReadyRef.current && sessionIdRef.current === sessionId) {
                console.log("[VoiceConsole] Force-enabling uploads (Timeout Fallback)");
                serverReadyRef.current = true; // FORCE ENABLE
            }
        }, 2000);

        fetch(listenUrlParams, { signal: abortController.signal }).then(async (response) => {
            console.log(`[VoiceConsole] Downlink connected. Status: ${response.status}`);
            
            // DEBUG: Bypass Ready Wait
            console.log("[VoiceConsole] Auto-enabling uploads (DEBUG BYPASS)");
            serverReadyRef.current = true;

            if (!response.ok) {
                 const txt = await response.text();
                 console.error(`[VoiceConsole] Downlink failed: ${txt}`);
                 alert(`Connection Failed: ${response.status} ${response.statusText}\n${txt}`);
                 throw new Error("Failed to connect down-link");
            }

            // Check if session is still valid (user may have stopped during connection)
            if (sessionIdRef.current !== sessionId) {
                console.log(`[VoiceConsole] Session ${sessionId} superseded by ${sessionIdRef.current}, ignoring.`);
                return;
            }

            // 5. Handle NDJSON Streaming Response
            if (response.body) {
                console.log("[VoiceConsole] Reading NDJSON stream...");
                const reader = response.body.getReader();
                downlinkReaderRef.current = reader; // Store for cleanup
                const decoder = new TextDecoder();
                let buffer = '';
                let totalBytes = 0;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        console.log(`[VoiceConsole] Stream ended. Total bytes: ${totalBytes}`);
                        break;
                    }
                    if (isPendingStopRef.current) {
                        console.log("[VoiceConsole] Stream reading stopped by client.");
                        break;
                    }

                    if (value) {
                        totalBytes += value.byteLength;
                        // Log first few chunks or periodically
                        if (totalBytes < 1000000) {
                             console.log(`[VoiceConsole] RX Chunk: ${value.byteLength} bytes. Total: ${totalBytes}`);
                        }
                    }

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || ''; // Keep incomplete line

                    for (let line of lines) {
                        line = line.trim();
                        if (!line) continue;
                        
                        // Parse SSE Data Format "data: {...}"
                        if (line.startsWith("data: ")) {
                            line = line.substring(6).trim();
                        } else if (line.startsWith(":")) {
                            // Comment (keep-alive)
                            continue;
                        }

                        // Debug: if line is just "ready", ignore valid JSON check
                        // But backend sends JSON stringified inside data
                        
                        try {
                            const msg = JSON.parse(line);
                            setRxCount(c => c + 1); // Increment counter
                            
                            if (msg.t === 'audio' && msg.d) {
                                // Audio Packet
                                playAudioChunk(base64ToUint8Array(msg.d), ctx, msg.s || 0);
                            } 
                            else if (msg.t === 'clear') {
                                // Barge-in Stop Signal
                                setDebugLog("RX: CLEAR SIGNAL");
                                stopPlayback(ctx);
                            }
                            else if (msg.t === 'ready') {
                                setDebugLog("RX: READY SIGNAL");
                                serverReadyRef.current = true;
                            }
                            else if (msg.t === 'ping') {
                                // Heartbeat - keep alive
                                setDebugLog("RX: PING (Heartbeat)");
                                // Do NOT allow heartbeat to reset silence/timeouts if we implement them later
                            } else {
                                console.log("[VoiceConsole] Received unknown message:", msg);
                            }

                        } catch (e) {
                             console.warn("[VoiceConsole] JSON Parse Error in stream", e);
                        }
                    }
                }
            }
            // IF LOOP BREAKS -> RECONNECT?
            // "Stream ended" usually means server closed connection.
            // If session is still 'live', we should probably try to reconnect or show status.
            console.log(`[VoiceConsole] Stream Loop Exited (Session ${sessionId})`);
            
            // Only show error if this is still the active session and not a user-initiated stop
            if (!isPendingStopRef.current && sessionIdRef.current === sessionId) {
               console.warn("[VoiceConsole] Stream died unexpectedly. Attempting reconnect...");
               setError("Voice connection lost. Please toggle off/on.");
               setStatus('error');
            } else {
               console.log(`[VoiceConsole] Ignoring stream end for stale session ${sessionId} (current: ${sessionIdRef.current})`);
            }
            
        }).catch (err => {
             // Ignore AbortError (expected when user stops session)
             if (err.name === 'AbortError') {
                 console.log(`[VoiceConsole] Downlink aborted for session ${sessionId} (expected).`);
                 return;
             }
             // Only set error if this is still the active session
             if (sessionIdRef.current === sessionId) {
                 console.error("[VoiceConsole] Voice Downlink Error:", err);
                 setError(err.message || 'Connection lost');
                 cleanup();
             } else {
                 console.log(`[VoiceConsole] Ignoring downlink error for stale session ${sessionId}`);
             }
        });
  };

  return (
    <div className="p-3 bg-white/5 border border-white/10 rounded-xl backdrop-blur-md transition-all">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium text-slate-200 flex items-center gap-2 text-sm">
            {/* Custom AI "Loop" Icon resembling a copilot assistant */}
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20" stroke="#38bdf8" strokeWidth="2.5" strokeLinecap="round" />
                <path d="M12 4C16.4183 4 20 7.58172 20 12C20 15 18 18 16 19" stroke="#818cf8" strokeWidth="2.5" strokeLinecap="round" />
                <circle cx="12" cy="12" r="2" fill="#38bdf8" />
            </svg>
            Copilot
            {status === 'live' && <span className="flex h-2.5 w-2.5 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500"></span>
            </span>}
        </h3>
        <div className="text-xs font-medium">
            {isOffline && <span className="text-red-500 font-bold">OFFLINE</span>}
            {!isOffline && status === 'idle' && <span className="text-slate-500">Ready</span>}
            {!isOffline && status === 'connecting' && <span className="text-yellow-500">Connecting...</span>}
            {!isOffline && status === 'live' && <span className="text-green-400">LIVE</span>}
            {!isOffline && status === 'error' && <span className="text-red-400">Error</span>}
        </div>
      </div>

      {error && (
        <div className="mb-3 p-2 bg-red-500/10 text-red-200 text-xs rounded border border-red-500/20">
            {error}
        </div>
      )}

      {/* Visualizers */}
      <div className="flex gap-3 mb-4">
          <div className="flex-1">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Microphone</div>
              <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-blue-500 transition-all duration-75 shadow-[0_0_8px_rgba(59,130,246,0.6)]"
                    style={{ width: `${Math.min(100, micVolume)}%` }}
                  />
              </div>
          </div>
          <div className="flex-1">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Incoming</div>
              <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-green-500 transition-all duration-75 shadow-[0_0_8px_rgba(34,197,94,0.6)]"
                    style={{ width: `${Math.min(100, incomingVolume)}%` }}
                  />
              </div>
          </div>
      </div>

      <div className="flex justify-center">
        {status === 'idle' || isOffline ? (
            <button
                onClick={startSession}
                disabled={!consultId || isOffline}
                className={`font-medium py-1.5 px-5 rounded-full shadow-lg hover:shadow-xl transition-all flex items-center gap-2 text-sm ${
                    !consultId || isOffline
                    ? 'bg-slate-700/50 cursor-not-allowed text-slate-500' 
                    : 'bg-blue-600 hover:bg-blue-500 text-white hover:scale-105'
                }`}
                title={isOffline ? "System is offline" : (!consultId ? "Select a consultation from the list above to start" : "Start Voice Session")}
            >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg>
                {consultId ? "Start Session" : "Select Consult"}
            </button>
        ) : (
            <button
                onClick={cleanup}
                className="bg-red-500/80 hover:bg-red-500 text-white font-medium py-1.5 px-5 rounded-full shadow-lg hover:shadow-red-500/20 transition-all flex items-center gap-2 text-sm hover:scale-105"
            >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                End Session
            </button>
        )}
      </div>

      <div className="mt-3 flex justify-between items-center px-1">
        <span className="text-[10px] text-slate-600">Azure AI VoiceLive • 24kHz</span>
        
        <div className="flex items-center gap-3">
            <button onClick={testAudio} className="text-slate-500 hover:text-blue-400 text-[10px] transition-colors">Test Tone</button>
            <button 
                onClick={() => setShowDebug(!showDebug)} 
                className="text-slate-600 hover:text-slate-400 text-[10px] flex items-center gap-1 focus:outline-none transition-colors"
            >
                {showDebug ? 'Hide' : 'Debug'} 
                <svg className={`w-3 h-3 transform transition-transform ${showDebug ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
            </button>
        </div>
      </div>

      {showDebug && (
       <div className="mt-2 text-[10px] font-mono bg-black/40 p-2 border border-white/5 rounded text-slate-400 break-all animate-in fade-in slide-in-from-top-1 duration-200 shadow-inner">
          <div className="flex justify-between border-b border-white/5 mb-1 pb-1">
            <span>RX Chunks: {rxCount}</span>
            <span className={status === 'live' ? 'text-green-500' : 'text-slate-500'}>{status}</span>
          </div>
          <div className="opacity-80">{debugLog}</div>
      </div>
      )}
    </div>
  );
}
