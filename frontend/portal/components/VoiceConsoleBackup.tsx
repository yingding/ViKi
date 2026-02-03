"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE_URL } from '../lib/config';

type Props = {
  consultId?: string;
};

type VoiceStatus = 'idle' | 'connecting' | 'live' | 'error';

type VoiceTokenResponse = {
  clientSecret: string;
  baseUrl: string;
  apiVersion: string;
  sessionId: string;
  expiresAt?: string;
  model: string;
};

export function VoiceConsole({ consultId }: Props) {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastConsultIdRef = useRef<string | undefined>(undefined);

  const teardown = useCallback((nextStatus: VoiceStatus = 'idle') => {
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setStatus(nextStatus);
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  useEffect(() => {
    const hasSelectionChanged =
      typeof lastConsultIdRef.current !== 'undefined' && consultId && lastConsultIdRef.current !== consultId;
    const shouldStop = (!consultId && status !== 'idle') || hasSelectionChanged;
    if (shouldStop) {
      teardown();
    }
    lastConsultIdRef.current = consultId;
  }, [consultId, status, teardown]);

  const startSession = useCallback(async () => {
    if (!consultId || status === 'connecting' || status === 'live') {
      return;
    }

    setError(null);
    setStatus('connecting');

    try {
      const tokenRes = await fetch(`${API_BASE_URL}/consults/${consultId}/voice-token`, {
        method: 'POST',
        cache: 'no-store'
      });
      if (!tokenRes.ok) {
        throw new Error(await tokenRes.text());
      }
      const token = (await tokenRes.json()) as VoiceTokenResponse;

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });
      pcRef.current = pc;

      pc.ontrack = (event) => {
        if (audioRef.current) {
          audioRef.current.srcObject = event.streams[0];
          void audioRef.current.play().catch(() => {
            /* autoplay already requested */
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
          setError('Realtime session disconnected');
          teardown('error');
        }
      };

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Browser cannot access the microphone.');
      }

      const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = localStream;
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);

      if (!pc.localDescription?.sdp) {
        throw new Error('Missing local description');
      }

      const url = `${token.baseUrl}/openai/realtime?api-version=${token.apiVersion}`;
      const answerResponse = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.clientSecret}`,
          'Content-Type': 'application/sdp'
        },
        cache: 'no-store',
        body: pc.localDescription.sdp
      });

      if (!answerResponse.ok) {
        throw new Error(await answerResponse.text());
      }

      const answerSdp = await answerResponse.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      setStatus('live');
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Failed to start realtime session');
      teardown('error');
    }
  }, [consultId, status, teardown]);

  const stopSession = useCallback(() => {
    if (status === 'live' || status === 'connecting') {
      teardown('idle');
    }
  }, [status, teardown]);

  return (
    <section className="rounded-3xl border border-[#1c3b6b] bg-[rgba(7,12,24,0.85)] p-5 shadow-xl">
      <div className="flex items-center justify-between">
        <h3 className="text-sm uppercase tracking-wider text-[var(--muted)]">Realtime Voice</h3>
        {status !== 'live' ? (
          <button
            type="button"
            disabled={!consultId || status === 'connecting'}
            className="rounded-full border border-[#00f3ff] px-4 py-2 text-xs font-semibold text-[#00f3ff] disabled:opacity-40"
            onClick={startSession}
          >
            {status === 'connecting' ? 'Connecting…' : 'Start session'}
          </button>
        ) : (
          <button
            type="button"
            className="rounded-full border border-[#f87171] px-4 py-2 text-xs font-semibold text-[#f87171]"
            onClick={stopSession}
          >
            Stop session
          </button>
        )}
      </div>
      <p className="mt-3 text-sm text-[var(--muted)]">
        {consultId ? `Status: ${status}` : 'Select a consult to enable voice review.'}
      </p>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      <audio ref={audioRef} autoPlay playsInline className="mt-4 w-full rounded-2xl bg-[#0c1527]" />
    </section>
  );
}

async function waitForIceGathering(pc: RTCPeerConnection) {
  if (pc.iceGatheringState === 'complete') {
    return;
  }

  await new Promise<void>((resolve) => {
    function checkState() {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', checkState);
        resolve();
      }
    }
    pc.addEventListener('icegatheringstatechange', checkState);
  });
}
