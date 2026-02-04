import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getConsult } from '../lib/consultRepository';
import { createVoiceLiveSession } from '../lib/voiceliveclient';
import { SessionManager } from '../lib/voiceSessionManager';

export async function handler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const id = request.params?.id;
    context.log(`[VoiceListen] Handler invoked for consultId: ${id}`);
    if (!id) return { status: 400, jsonBody: { error: 'Missing consult id' } };

    try {
        context.log(`[VoiceListen] Fetching consult ${id}...`);
        
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

        // 1. Create Readable Stream (The Downlink)
        // Direct control via controller avoids TransformStream buffering/deadlock issues
        let streamController: ReadableStreamDefaultController<any>;
        let hbInterval: any;

        const readable = new ReadableStream({
            start(controller) {
                streamController = controller;
            },
            cancel() {
                console.log("[VoiceListen] Stream cancelled by client");
                clearInterval(hbInterval); // STOP HEARTBEAT
                SessionManager.remove(id).catch(e => console.error(e));
            }
        });

        // 2. Clear previous session if exists
        await SessionManager.remove(id);

        // ... Session creation ...
        context.log(`[VoiceListen] Creating VoiceLive session for ${id}...`);
        const session = await createVoiceLiveSession(consult, {
            onAudioData: async (data) => {
                const s = SessionManager.get(id);
                if (s && s.outputController) {
                    try {
                        console.log(`[VoiceListen] Enqueuing ${data.byteLength} bytes`);
                        s.outputController.enqueue(data);
                    } catch (e) {
                         console.warn("[VoiceListen] Failed to enqueue chunk (closed?)", e);
                         clearInterval(hbInterval);
                    }
                }
            },
            onInputStarted: () => {
                console.log("[VoiceListen] User started speaking (VAD)");
            }
        });

        // 4. Register Session
        console.log(`[VoiceListen] Session created. Registering...`);
        SessionManager.register(id, session);
        SessionManager.attachController(id, streamController!);
        
        // Send initial silence to flush headers and unblock client
        // Doing this asynchronously to ensure headers are sent first, after the response object is returned
        setTimeout(() => {
            const FLUSH_SIZE = 64 * 1024; 
            const silence = new Uint8Array(FLUSH_SIZE).fill(0); 
            
            try {
                 streamController!.enqueue(silence);
                 console.log(`[VoiceListen] Flushed ${FLUSH_SIZE} bytes of silence.`);
            } catch(e) { 
                console.warn("[VoiceListen] Flush failed", e);
            }
            
            // Setup Heartbeat
            console.log("[VoiceListen] Starting heartbeat...");
             hbInterval = setInterval(() => {
                try {
                    const ping = new Uint8Array(32).fill(0);
                    streamController!.enqueue(ping);
                } catch (e) {
                    clearInterval(hbInterval);
                }
            }, 50);
        }, 50);

        context.log(`[VoiceListen] Stream established. Returning 200 OK.`);

        // Force a specific internal error if controller missing
        if (!streamController!) {
             context.error("[VoiceListen] Stream controller not initialized!");
             return { status: 500, body: "Stream error" };
        }

        // Direct return of readable
        return {
            status: 200,
            headers: {
                'Content-Type': 'application/octet-stream',
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff'
                // Removed manual CORS headers to avoid conflict with Host.CORS
            },
            body: readable as any
        };

    } catch (error) {
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
