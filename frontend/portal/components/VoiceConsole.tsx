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

  const stopPlayback = useCallback((ctx: AudioContext) => {
    console.log("[VoiceConsole] Interrupt! Stopping playback (Barge-in)");
    activeSourcesRef.current.forEach(node => {
        try { node.stop(); } catch(e) {}
    });
    activeSourcesRef.current = [];
    // Reset Start Time to now so new audio plays immediately
    nextStartTimeRef.current = ctx.currentTime;
  }, []);

  const cleanup = useCallback(() => {
    isPendingStopRef.current = true;
    
    // Stop all playing audio
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

  const playAudioChunk = (data: Uint8Array, ctx: AudioContext) => {
      if (ctx.state === 'closed') {
          console.warn("[VoiceConsole] Context is closed, skipping chunk play");
          return;
      }
      if (ctx.state === 'suspended') {
          ctx.resume().catch(e => console.warn("Resume failed", e));
      }

      // Decode Int16 -> Float32
      const bufferCopy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const int16 = new Int16Array(bufferCopy);
      
      const float32 = new Float32Array(int16.length);
      const PLAYBACK_GAIN = 1.2; // Mild boost for reception
      
      let sumSq = 0;
      for (let i = 0; i < int16.length; i++) {
          float32[i] = Math.max(-1, Math.min(1, (int16[i] / 32768.0) * PLAYBACK_GAIN));
          sumSq += float32[i] * float32[i];
      }
      
      const rms = Math.sqrt(sumSq / int16.length);
      setIncomingVolume(Math.min(100, rms * 500)); 
      
      // Update Debug Log with RMS to verify data silence vs playback silence
      setDebugLog(`RX: ${data.length}b, RMS=${rms.toFixed(4)}, CTX=${ctx.state}`);

      try {
        if (ctx.state === 'suspended') {
             setDebugLog(`RESUMING CTX...`);
             ctx.resume();
        }

        const buffer = ctx.createBuffer(1, float32.length, 24000);
        buffer.getChannelData(0).set(float32);

        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);

        const now = ctx.currentTime;
        // Fix drift: If we are behind (underrun) or too far ahead (latency > 200ms)
        if (nextStartTimeRef.current < now || (nextStartTimeRef.current - now) > 0.2) {
             // console.log("Drift correction: Resetting playback time");
             nextStartTimeRef.current = now;
        }
        
        const startTime = nextStartTimeRef.current;
        src.start(startTime);
        nextStartTimeRef.current = startTime + buffer.duration;
        
        // Debug
        // setDebugLog(`Play: ${rms.toFixed(3)} @ ${startTime.toFixed(1)}`);

        // Track active source for cancellation
        activeSourcesRef.current.push(src);
        src.onended = () => {
            const index = activeSourcesRef.current.indexOf(src);
            if (index > -1) {
                activeSourcesRef.current.splice(index, 1);
            }
        };

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


    try {
        // 1. Setup AudioContext (request 24kHz for compatibility)
        console.log("[VoiceConsole] Initializing AudioContext (24kHz)...");
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        const ctx = new AudioContextClass({ sampleRate: 24000 });
        audioContextRef.current = ctx;
        nextStartTimeRef.current = ctx.currentTime;
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
        await connectDownlink(ctx);
        
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
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 24000 
            } 
        });
        console.log("[VoiceConsole] Microphone stream obtained.");
        mediaStreamRef.current = stream;

        const source = ctx.createMediaStreamSource(stream);
        const workletNode = new AudioWorkletNode(ctx, 'pcm-processor');
        processorRef.current = workletNode;

        source.connect(workletNode);
        workletNode.connect(ctx.destination); // Keep alive
        console.log("[VoiceConsole] Audio graph connected.");

        // 3. Create Request Stream Processing Loop
        const CHUNK_SIZE_MS = 100; // Reduced from 250ms for lower latency
        const SAMPLE_RATE = 24000; 
        const BYTES_PER_SAMPLE = 2; // Int16
        const BUFFER_SIZE = (SAMPLE_RATE * CHUNK_SIZE_MS) / 1000 * BYTES_PER_SAMPLE; 
        const DIGITAL_GAIN = 5.0; // Reduced from 15.0 to prevent clipping
        const PRE_AMP = 1.0;      // Reduced from 2.0

        let pcmBuffer = new Uint8Array(0);
        let uploadQueue = Promise.resolve();

        workletNode.port.onmessage = (event) => {
            if (status === 'error' || isPendingStopRef.current) return;
            // Float32 -> Int16 conversion
            const float32 = new Float32Array(event.data);
            
            // Noise Gate Calculation (RMS)
            let sumSq = 0;
            for(let i=0; i<float32.length; i++) {
                sumSq += float32[i] * float32[i];
            }
            const rms = Math.sqrt(sumSq / float32.length);
            
            // Threshold: Lowered to 0.002 to avoid cutting off quiet speech
            const NOISE_GATE_THRESHOLD = 0.002; 
            const isSilence = rms < NOISE_GATE_THRESHOLD;

            // Debug RMS occasionally
            if (Math.random() < 0.05) {
                 // setDebugLog(`RMS: ${rms.toFixed(5)} Gate: ${isSilence ? 'ON' : 'OFF'}`);
            }

            const int16 = new Int16Array(float32.length);
            for (let i = 0; i < float32.length; i++) {
                // Apply gain and clip
                // If silence, zero it out.
                const sample = isSilence ? 0 : float32[i];
                const s = Math.max(-1, Math.min(1, sample * DIGITAL_GAIN * PRE_AMP));
                int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }

            const newBuffer = new Uint8Array(pcmBuffer.length + int16.byteLength);
            newBuffer.set(pcmBuffer);
            newBuffer.set(new Uint8Array(int16.buffer), pcmBuffer.length);
            pcmBuffer = newBuffer;

            // Visual Mic Volume
            // Use the calculated RMS, but if gated, show 0 to match reality
            const visualRms = isSilence ? 0 : (rms * DIGITAL_GAIN);
            setMicVolume(v => Math.max(v * 0.9, visualRms * 100)); // Smooth decay

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

  const connectDownlink = async (ctx: AudioContext) => {
        // 4. Start Listen Stream (Downlink)
        const listenUrl = `${API_BASE_URL}/consults/${consultId}/voice-listen`;
        console.log(`[VoiceConsole] Connecting to downlink: ${listenUrl}`);
        
        setStatus('live');

        // Execute Listen in background
        const listenUrlParams = listenUrl + '?_t=' + Date.now();
        
        // Safety Fallback: If connect hangs, enable upload anyway after 2 seconds
        // (Reduced from 6s to help with buffering issues)
        setTimeout(() => {
            if (!serverReadyRef.current) {
                console.log("[VoiceConsole] Force-enabling uploads (Timeout Fallback)");
                serverReadyRef.current = true; // FORCE ENABLE
            }
        }, 2000);

        fetch(listenUrlParams).then(async (response) => {
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

            // 5. Handle NDJSON Streaming Response
            if (response.body) {
                console.log("[VoiceConsole] Reading NDJSON stream...");
                const reader = response.body.getReader();
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
                                playAudioChunk(base64ToUint8Array(msg.d), ctx);
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
                            } else {
                                console.log("[VoiceConsole] Received unknown message:", msg);
                            }

                        } catch (e) {
                             console.warn("[VoiceConsole] JSON Parse Error in stream", e);
                        }
                    }
                }
            }
            cleanup();
        }).catch (err => {
             console.error("[VoiceConsole] Voice Downlink Error:", err);
             setError(err.message || 'Connection lost');
             cleanup();
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
        {status === 'idle' || status === 'error' || isOffline ? (
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
