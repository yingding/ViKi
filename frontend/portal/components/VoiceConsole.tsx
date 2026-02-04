"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE_URL } from '../lib/config';

type Props = {
  consultId?: string;
};

type VoiceStatus = 'idle' | 'connecting' | 'live' | 'error';

export function VoiceConsole({ consultId }: Props) {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [incomingVolume, setIncomingVolume] = useState<number>(0);
  const [micVolume, setMicVolume] = useState<number>(0);

  // Audio Processing Refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<AudioNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const isPendingStopRef = useRef<boolean>(false);

  const cleanup = useCallback(() => {
    isPendingStopRef.current = true;
    
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
  }, []);

  useEffect(() => {
     return () => cleanup();
  }, [cleanup]);

  useEffect(() => {
    if (!consultId && status !== 'idle') {
      cleanup();
    }
  }, [consultId, status, cleanup]);

  const startSession = async () => {
    if (!consultId) return;

    setStatus('connecting');
    setError(null);
    isPendingStopRef.current = false;

    try {
        // 1. Setup AudioContext (request 24kHz for compatibility)
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        const ctx = new AudioContextClass({ sampleRate: 24000 });
        audioContextRef.current = ctx;
        nextStartTimeRef.current = ctx.currentTime;

        // Load AudioWorklet Module
        try {
            await ctx.audioWorklet.addModule('/pcm-processor.js');
        } catch (e) {
            console.warn("Failed to load worklet, falling back involves complex logic not implemented here since we expect worklet support.");
            throw new Error("AudioWorklet support required");
        }

        // 2. Get Microphone Stream
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error("Microphone access not supported");
        }
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            } 
        });
        mediaStreamRef.current = stream;

        const source = ctx.createMediaStreamSource(stream);
        const workletNode = new AudioWorkletNode(ctx, 'pcm-processor');
        processorRef.current = workletNode;

        source.connect(workletNode);
        workletNode.connect(ctx.destination); // Keep alive

        // 3. Create Request Stream Processing Loop
        // Instead of one long Fetch, we accumulate and send chunks
        const CHUNK_SIZE_MS = 250; 
        const SAMPLE_RATE = 24000;
        const BYTES_PER_SAMPLE = 2; // Int16
        const BYTES_PER_MS = (SAMPLE_RATE * BYTES_PER_SAMPLE) / 1000;
        // ~ 12000 bytes for 250ms
        const targetBufferSize = BYTES_PER_MS * CHUNK_SIZE_MS;

        let bufferAccumulator: Uint8Array = new Uint8Array(0);

        workletNode.port.onmessage = async (e) => {
            if (isPendingStopRef.current) return;
            const newChunk = new Uint8Array(e.data); // Int16 buffer
            
            // Append
            const tmp = new Uint8Array(bufferAccumulator.length + newChunk.length);
            tmp.set(bufferAccumulator, 0);
            tmp.set(newChunk, bufferAccumulator.length);
            bufferAccumulator = tmp;

            if (bufferAccumulator.length >= targetBufferSize) {
                const toSend = bufferAccumulator;
                
                // Calculate Mic Volume (RMS) for UI feedback
                // View as Int16 to get correct amplitude
                const int16View = new Int16Array(toSend.buffer, toSend.byteOffset, toSend.byteLength / 2);
                let sumSq = 0;
                // Sample every 4th point to save CPU
                for(let i = 0; i < int16View.length; i += 4) {
                    const v = int16View[i] / 32768.0;
                    sumSq += v*v;
                }
                const rms = Math.sqrt(sumSq / (int16View.length / 4));
                setMicVolume(Math.min(100, rms * 500)); 

                bufferAccumulator = new Uint8Array(0); // Reset
                
                // Fire and forget send
                try {
                     await fetch(`${API_BASE_URL}/consults/${consultId}/voice-send`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/octet-stream' },
                        body: toSend as any
                    });
                } catch(err) {
                    console.warn("Error sending chunk", err);
                }
            }
        };

        // 4. Start Listening (Downlink)
        // Ensure this is open BEFORE we start sending? 
        const listenUrl = `${API_BASE_URL}/consults/${consultId}/voice-listen`;
        console.log(`[VoiceConsole] Listening on: ${listenUrl}`);
        
        // Optimistically set Live so Mic works immediately
        setStatus('live');

        // Execute Listen in background (don't await) to prevent UI blocking
        const listenUrlParams = listenUrl + '?_t=' + Date.now();
        fetch(listenUrlParams).then(async (response) => {
            console.log(`[VoiceConsole] Listen status: ${response.status}`);
            if (!response.ok) {
                 throw new Error("Failed to connect down-link");
            }

            // 5. Handle Streaming Response
            if (response.body) {
                console.log("[VoiceConsole] Reading response stream...");
                const reader = response.body.getReader();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        console.log("[VoiceConsole] Stream complete");
                        break;
                    }
                    if (isPendingStopRef.current) break;
                    
                    if (value) {
                         console.log(`[VoiceConsole] Chunk received: ${value.byteLength} bytes`);
                        playAudioChunk(value, ctx);
                    }
                }
            }
            cleanup();
        }).catch (err => {
             console.error("Voice Downlink Error:", err);
             setError(err.message || 'Connection lost');
             cleanup();
        });

    } catch (err: any) {
        console.error(err);
        setError(err.message || 'Error starting session');
        cleanup();
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

      // Check for HTML error response disguised as audio
      if (data.length > 0 && data[0] === 60) { // '<' character
          const text = new TextDecoder().decode(data.slice(0, 100));
          if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
              console.error("[VoiceConsole] Received HTML instead of Audio:", text);
              return;
          }
      }

      console.log(`[VoiceConsole] Received audio chunk: ${data.byteLength} bytes`);

      // Decode Int16 -> Float32
      // Copy to ensure alignment and prevent RangeError if byteOffset is odd
      const bufferCopy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const int16 = new Int16Array(bufferCopy);
      
      const float32 = new Float32Array(int16.length);
      let sumSq = 0;
      for (let i = 0; i < int16.length; i++) {
          float32[i] = int16[i] / 32768.0;
          sumSq += float32[i] * float32[i];
      }
      
      const rms = Math.sqrt(sumSq / int16.length);
      if (rms > 0.01) {
        console.log(`[VoiceConsole] Playing chunk: ${data.byteLength} bytes, RMS: ${rms.toFixed(4)}`);
      }
      // Update visual volume (decay handled by react re-renders or next chunk)
      setIncomingVolume(Math.min(100, rms * 500)); // Amplify for display

      try {
        const buffer = ctx.createBuffer(1, float32.length, 24000);
        buffer.getChannelData(0).set(float32);

        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);

        const now = ctx.currentTime;
        // Schedule playback
        const startTime = Math.max(now, nextStartTimeRef.current);
        src.start(startTime);
        nextStartTimeRef.current = startTime + buffer.duration;
      } catch (e) {
          console.warn("[VoiceConsole] Playback error:", e);
      }
  };

  const stopSession = () => {
      cleanup();
  };

  const testAudioOutput = async () => {
    try {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        const ctx = new AudioContextClass();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        
        osc.frequency.value = 440; // A4
        gain.gain.value = 0.1;
        
        osc.start();
        setTimeout(() => {
            osc.stop();
            ctx.close();
        }, 500);
    } catch (e) {
        alert("Audio Output Failed: " + String(e));
    }
  };

  return (
    <div className="flex items-center justify-between gap-6">
      <div className="flex items-center gap-4">
        {/* Status Indicator */}
        <div className={`relative flex h-12 w-12 items-center justify-center rounded-full border transition-all duration-500 ${
            status === 'live' 
            ? 'border-red-500/50 bg-red-500/10 shadow-[0_0_20px_rgba(239,68,68,0.3)]' 
            : status === 'connecting'
                ? 'border-yellow-400/50 bg-yellow-400/10 animate-pulse'
                : 'border-white/10 bg-white/5'
        }`}>
            {status === 'live' ? (
                <div className="flex gap-0.5">
                    <div className="h-4 w-1 animate-[music_1s_ease-in-out_infinite] bg-red-500"></div>
                    <div className="h-6 w-1 animate-[music_1.2s_ease-in-out_infinite] bg-red-500 delay-75"></div>
                    <div className="h-3 w-1 animate-[music_0.8s_ease-in-out_infinite] bg-red-500 delay-150"></div>
                </div>
            ) : (
                <svg className={`h-5 w-5 ${status === 'connecting' ? 'text-yellow-400' : 'text-slate-500'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
            )}
        </div>

        <div>
            <h3 className="text-sm font-semibold text-white">Live Voice Channel</h3>
            <div className="text-xs text-slate-400 flex items-center gap-4">
                {status === 'idle' && (consultId ? 'Ready to connect' : 'Select a patient case')}
                {status === 'connecting' && 'Establishing secure uplink...'}
                {status === 'live' && (
                  <>
                  <span className="text-red-400 flex items-center gap-2">
                    ● ACTIVE
                  </span>
                  
                   {/* Mic Volume */}
                   <div className="flex items-center gap-2" title="Microphone Input Level">
                        <svg className={`h-3 w-3 ${micVolume > 5 ? 'text-white' : 'text-slate-600'}`} fill="currentColor" viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
                        <span className="block h-1.5 w-12 overflow-hidden rounded-full bg-slate-800">
                             <span 
                                className="block h-full bg-white transition-all duration-100 ease-out"
                                style={{ width: `${micVolume}%` }}
                             ></span>
                        </span>
                   </div>

                   {/* Rx Volume */}
                   <div className="flex items-center gap-2" title="Incoming Voice Level">
                        <svg className={`h-3 w-3 ${incomingVolume > 5 ? 'text-green-400' : 'text-slate-600'}`} fill="currentColor" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
                        <span className="block h-1.5 w-12 overflow-hidden rounded-full bg-slate-800">
                            <span 
                                className="block h-full bg-green-500 transition-all duration-100 ease-out"
                                style={{ width: `${incomingVolume}%` }}
                            ></span>
                        </span>
                   </div>
                   </>
                )}
                {error && <span className="text-red-400">{error}</span>}
            </div>
        </div>
      </div>

      <div className="flex items-center gap-4">
         <button 
            onClick={testAudioOutput}
            className="text-xs text-slate-500 hover:text-white underline decoration-dashed"
         >
            Test Spk
         </button>

         {status === 'live' && (
             <div className="hidden items-center gap-2 text-xs font-mono text-slate-500 md:flex">
                <span>24kHz</span>
                <span className="text-slate-700">|</span>
                <span>PCM-16</span>
             </div>
         )}
         
         {!consultId ? (
             <button disabled className="rounded-lg bg-white/5 px-6 py-2.5 text-sm font-semibold text-slate-500 cursor-not-allowed">
                Select Case
             </button>
         ) : status === 'live' ? (
            <button
                onClick={stopSession}
                className="group relative flex items-center gap-2 overflow-hidden rounded-lg bg-red-500/10 px-6 py-2.5 text-sm font-semibold text-red-500 transition-all hover:bg-red-500 hover:text-white"
            >
                <span className="relative z-10">End Session</span>
            </button>
         ) : (
            <button
                onClick={startSession}
                disabled={status === 'connecting'}
                className="group relative flex items-center gap-2 overflow-hidden rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-500/20 transition-all hover:bg-blue-500 hover:scale-105 active:scale-95 disabled:opacity-50 disabled:hover:scale-100"
            >
                <span className="relative z-10">
                    {status === 'connecting' ? 'Connecting...' : 'Start Session'}
                </span>
            </button>
         )}
      </div>
    </div>
  );
}
