# Voice System Technical Summary

Date: 2026-02-05

This document summarizes the UI meter behavior, user audio input processing, session management, and audio playback pipeline changes implemented in the voice subsystem. It is intended as a concise technical reference for current behavior and rationale.

## Scope
- Frontend UI meters for mic and incoming audio
- User audio input capture and conditioning for VoiceLive
- Session management (start/stop and reconnect safety)
- Audio playback quality and jitter handling

## User Audio Input (Capture and Conditioning)
Location: frontend/portal/components/VoiceConsole.tsx

Current processing steps:
1) getUserMedia with processing disabled:
   - echoCancellation: false
   - noiseSuppression: false
   - autoGainControl: false
   Rationale: Avoid browser DSP altering mic signal; manual processing is applied.

2) AudioWorklet capture (pcm-processor.js) provides Float32 frames to the UI thread.

3) High-pass filter for DC removal:
   - DC-blocking high-pass filter applied per sample
   - HP_ALPHA tuned to preserve low-frequency energy while preventing bias
   Rationale: Fixes stuck meter and removes DC drift.

4) Noise floor calibration:
   - First 2 seconds collect RMS samples
   - Noise floor derived from low percentile with small margin
   Rationale: Adaptive baseline for gating without cutting speech.

5) Adaptive noise gate:
   - Threshold based on calibrated noise floor
   - Gate is relaxed to avoid cutting early syllables

6) Adaptive gain:
   - Base gain increased
   - Min/Max gain widened for quiet mics
   - Target RMS raised for stronger VoiceLive input
   - Faster adaptation to respond to quiet speakers

7) Soft limiter (tanh):
   - Prevents hard clipping while preserving dynamics

8) Chunking:
   - 100ms chunks at 24kHz
   - Upload gating uses server-ready signal with buffering protection

Summary of improvements:
- Stronger input levels to VoiceLive
- Less aggressive gating and more responsive adaptive gain
- DC offset removed without altering tone
- Minimal latency increase

## UI Meters (Visual Indicators)
Location: frontend/portal/components/VoiceConsole.tsx

Mic meter (local):
- Uses raw RMS before gating to keep visual feedback responsive
- Separate visual floor (micMeterFloorRef) calibrated from low percentile
- Normalized to a fixed target RMS for consistent display
- Smoothed blend for stability while keeping responsiveness

Incoming meter (AI audio):
- Uses analyser RMS with DC removal
- Normalized to a fixed target RMS (no isPlayingRef-based multiplier)
- Activity-based decay to avoid stuck-high indicators after speech ends

Summary of improvements:
- Mic meter rises on speech even when gate is active
- Incoming meter follows AI audio dynamics without pinning high
- Both meters decay naturally on silence

## Audio Playback (AI Voice)
Location: frontend/portal/components/VoiceConsole.tsx and frontend/portal/public/pcm-player.js

Key components:
- Jitter buffer + reorder buffer using sequence numbers
- 300ms pre-roll to prevent chopped syllables
- AudioWorklet playback with ring buffer and overflow protection
- Soft limiter on playback path
- Stereo output (mono -> stereo) for stable playback

Summary of improvements:
- Smooth, consistent playback (no robotic artifacts)
- Robust handling of out-of-order or delayed packets
- Reduced start clipping via pre-roll buffer

## Session Management
Location: frontend/portal/components/VoiceConsole.tsx

Changes:
- AbortController to cancel downlink fetch on stop
- Reader cancel on cleanup to prevent stale stream callbacks
- Session ID guard to ignore stale events and errors
- Reset of server-ready state and early chunk queue on new session

Summary of improvements:
- Restarting sessions no longer triggers false "Voice connection lost" errors
- Old streams cannot override current session state
- Clean stop/start transitions

## Key Files
- frontend/portal/components/VoiceConsole.tsx
- frontend/portal/public/pcm-player.js
- frontend/portal/public/pcm-processor.js
- backend/functions/src/functions/consultVoiceListen.ts

## Operational Notes
- All changes preserve existing barge-in and playback behavior
- UI meter fixes are visual-only and do not alter audio data
- Input conditioning is designed to improve recognition without introducing clipping
