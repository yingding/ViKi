import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { Readable, PassThrough } from 'stream';
import { Buffer } from 'buffer';
import { getConsult } from '../lib/consultRepository';
import { createVoiceLiveSession, logToDebug } from '../lib/voiceliveclient';
import { SessionManager } from '../lib/voiceSessionManager';

export async function handler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const id = request.params?.id;
    logToDebug(`[VoiceListen] Handler invoked for consultId: ${id}`);
    context.log(`[VoiceListen] Handler invoked for consultId: ${id}`);
    if (!id) return { status: 400, jsonBody: { error: 'Missing consult id' } };


    // DEBUG: SIMPLE STREAM TEST (Standard Web API Pattern)
    if (id === 'debug-stream') {
        const stream = new ReadableStream({
            async start(controller) {
                // Send initial keep-alive
                controller.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
                
                for (let i = 0; i < 10; i++) {
                    const msg = `data: {"count": ${i}, "ts": "${new Date().toISOString()}"}\n\n`;
                    controller.enqueue(new TextEncoder().encode(msg));
                    await new Promise(r => setTimeout(r, 500)); // 500ms delay
                }
                controller.close();
            }
        });

        return { 
            status: 200,
            headers: { 
                 'Content-Type': 'text/event-stream; charset=utf-8',
                 'Cache-Control': 'no-cache, no-transform',
                 'X-Accel-Buffering': 'no'
             },
            body: stream as any
        };
    }

    try {
        logToDebug(`[VoiceListen] Fetching consult ${id}...`);
        
        let consult;
        if (id === '0-0') {
             consult = {
                id: "0-0",
                convId: 0,
                msgId: 0,
                senderEmail: "admin@system.local",
                receivedAt: new Date().toISOString(),
                payload: {
                    msgId: 0, 
                    convId: 0,
                    created: Date.now(),
                    senderEmail: "admin@system.local",
                    msgType: "text",
                    msgText: "System Check"
                }
             };
        } else {
             consult = await getConsult(id);
        }

        if (!consult) {
            context.log(`[VoiceListen] Consult ${id} not found`);
            return { status: 404, jsonBody: { error: 'Consult not found' } };
        }

        // Connect to VoiceSession
        let hbInterval: NodeJS.Timeout;

        const stream = new ReadableStream({
            async start(controller: ReadableStreamDefaultController) {
                // 0. Initial Open
                controller.enqueue(new TextEncoder().encode(": keep-alive\n\n"));

                // 1. Setup Heartbeat
                hbInterval = setInterval(() => {
                    try {
                        controller.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
                    } catch (e) {
                         clearInterval(hbInterval);
                    }
                }, 10000);

                try {
                     // 2. Setup Session
                     await SessionManager.remove(id); // Clean any stale session
                     
                     const ticket = SessionManager.reserve(id);
                     
                     let chunkCount = 0;
                     const session = await createVoiceLiveSession(consult, {
                        onAudioData: (data: Uint8Array) => {
                             try {
                                // Direct Passthrough - No Buffering
                                if (!data || data.byteLength === 0) return;
                                chunkCount++;
                                if (chunkCount <= 5 || chunkCount % 10 === 0) {
                                    context.log(`[VoiceListen] Sending chunk #${chunkCount} (${data.byteLength} bytes)`);
                                }
                                const b64 = Buffer.from(data).toString('base64');
                                // Add 's' (sequence) to the payload
                                const msg = `data: ${JSON.stringify({ t: 'audio', d: b64, s: chunkCount })}\n\n`;
                                controller.enqueue(new TextEncoder().encode(msg));
                             } catch (e) {
                                 context.warn(`[VoiceListen] Error enqueueing audio: ${e}`);
                             }
                        },
                        onInputStarted: () => {
                             try {
                                context.log(`[VoiceListen] InputStarted detected. Sending clear...`);
                                const msg = `data: ${JSON.stringify({ t: 'clear' })}\n\n`;
                                controller.enqueue(new TextEncoder().encode(msg));
                             } catch (e) { /* ignore */ }
                        }
                     });

                     SessionManager.register(id, session, ticket); // Pass ticket to prevent race conditions
                     
                     // Attach controller to session manager to allow external closing
                     SessionManager.attachController(id, controller);

                     // 3. Send Ready
                     controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ t: 'ready' })}\n\n`));

                } catch (err: any) {
                    context.error(`[VoiceListen] Setup failed: ${err}`);
                    controller.error(err);
                    clearInterval(hbInterval);
                }
            },
            cancel() {
                context.log(`[VoiceListen] Stream cancelled for ${id}`);
                clearInterval(hbInterval);

                SessionManager.remove(id).catch(e => context.error(e));
            }
        });

        return {
            status: 200,
            headers: {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'X-Accel-Buffering': 'no'
            },
            body: stream as any
        };

    } catch (error: any) {
        logToDebug(`[VoiceListen] CRITICAL ERROR for ${id}: ${error.message} \nStack: ${error.stack}`);
        context.error(`[VoiceListen] Error ${id}`, error);
        return { status: 500, jsonBody: { error: 'Internal server error' } };
    }
}

app.http('consult-voice-listen', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'consults/{id}/voice-listen',
    handler
});
