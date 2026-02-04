import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { SessionManager } from '../lib/voiceSessionManager';
import { sendAudioInput } from '../lib/voiceliveclient';

export async function handler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const id = request.params?.id;
    if (!id) return { status: 400, jsonBody: { error: 'Missing consult id' } };

    try {
        const active = SessionManager.get(id);
        if (!active) {
            return { status: 404, jsonBody: { error: 'No active session. Connect to voice-listen first.' } };
        }

        // Read audio chunk from request body
        // Use standard arrayBuffer() method which handles stream reading automatically
        let audioData: Uint8Array;
        
        try {
            audioData = new Uint8Array(await request.arrayBuffer());
        } catch (e) {
            // Fallback for some environments
             if (request.body && typeof (request.body as any).getReader === 'function') {
                const reader = (request.body as any).getReader();
                const chunks = [];
                while(true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                }
                const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
                audioData = new Uint8Array(totalLength);
                let offset = 0;
                for(const c of chunks) {
                    audioData.set(c, offset);
                    offset += c.length;
                }
            } else {
                throw new Error("Unable to read request body");
            }
        }

        if (audioData.byteLength > 0) {
            context.log(`[VoiceSend] Received ${audioData.byteLength} bytes. Sending to session...`);
            // Send to session
            await sendAudioInput(active.session, audioData);
        } else {
            context.warn(`[VoiceSend] Received empty body.`);
        }

        return { status: 200 };

    } catch (error) {
        context.error(`[VoiceSend] Error ${id}`, error);
        return { status: 500 };
    }
}

app.http('consult-voice-send', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'consults/{id}/voice-send',
    handler
});
