import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getConsult } from '../lib/consultRepository';
import { createVoiceLiveSession } from '../lib/voiceliveclient';

export async function handler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const id = request.params?.id;
    context.log(`[VoiceInput] Request received for consultId: ${id}`);
    
    if (!id) {
        return { status: 400, jsonBody: { error: 'Missing consult id' } };
    }

    // DIAGNOSTIC: Check if we are in mock mode or connectivity check
    if (request.query.get('check') === 'true') {
        return { status: 200, jsonBody: { status: 'online', id } };
    }

    let session: any = null;
    let isRequestEnded = false;

    try {
        const consult = await getConsult(id);
        if (!consult) {
            context.warn(`[VoiceInput] Consult ${id} not found`);
            return { status: 404, jsonBody: { error: 'Consult not found' } };
        }

        // Create a streaming response
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();

        // 1. Initialize VoiceLive Session
        context.log(`[VoiceInput] Initializing VoiceLive session for ${id}...`);
        try {
            session = await createVoiceLiveSession(consult, {
                onAudioData: async (data) => {
                    // Determine if we can write
                    try {
                        // Write audio chunk to the response stream
                        await writer.write(data);
                    } catch (e) {
                        context.error("[VoiceInput] Error writing to response stream", e);
                    }
                },
                onInputStarted: () => {
                   context.log("[VoiceInput] User input started");
                }
            });
            context.log(`[VoiceInput] VoiceLive session established.`);
        } catch (sessionErr: any) {
            context.error(`[VoiceInput] Failed to create VoiceLive session: ${sessionErr.message}`, sessionErr);
            // Fallback: If session fails, maybe we just echo? 
            // Or return 500. Let's return 500 for now to be clear.
            return { status: 500, jsonBody: { error: `Voice Service Unavailable: ${sessionErr.message}` } };
        }

        // 2. Handle Input Stream (Request Body) -> VoiceLive
        // We act as a sink for the request body.
        const reader = request.body?.getReader();
        
        if (reader) {
            // Process input in background
            const inputLoop = async () => {
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        if (value && session.isConnected) {
                            await session.sendAudio(value);
                        }
                    }
                } catch (err) {
                    context.error("Error processing input stream", err);
                } finally {
                    // When input ends, usually we might want to wait for pending responses?
                    // For now, we'll assume the client disconnects the output stream to kill connection.
                    // Or keep session alive for a bit?
                    // Ideally, dispose session when both streams are done.
                }
            };
            // Start reading but don't await blocking the response return
            inputLoop();
        }

        // 3. Return the persistent stream immediately
        // Hook into stream cancellation to dispose session
        const trackedReadable = new ReadableStream({
            start(controller) {
                // Pipe the transform stream's readable to this new readable
                const reader = readable.getReader();
                const pump = async () => {
                   try {
                       while (true) {
                           const { done, value } = await reader.read();
                           if (done) {
                               controller.close();
                               break;
                           }
                           controller.enqueue(value);
                       }
                   } catch (e) {
                       controller.error(e);
                   }
                };
                pump();
            },
            async cancel(reason) {
                context.log("Client disconnected (stream cancelled), disposing session.");
                if (session) {
                    await session.dispose();
                }
            }
        });
        
        return {
            status: 200,
            headers: {
                'Content-Type': 'application/octet-stream',
                'Transfer-Encoding': 'chunked'
            },
            body: trackedReadable as any
        };

    } catch (error) {
        context.error(`Failed to handle voice input for consult ${id}`, error);
        if (session) await session.dispose();
        return { status: 500, jsonBody: { error: 'Internal server error' } };
    }
}

app.http('consult-voice-input', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'consults/{id}/voice-input',
    handler
});
