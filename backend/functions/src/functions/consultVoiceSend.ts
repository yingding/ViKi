import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { SessionManager } from '../lib/voiceSessionManager';
import { sendAudioInput, logToDebug } from '../lib/voiceliveclient';
import * as fs from 'fs';
import * as path from 'path';

function logVoiceSend(msg: string) {
    try {
        const logPath = path.resolve(process.cwd(), '../../app.log');
        const fallbackPath = 'C:\\Users\\yingdingwang\\Documents\\VCS\\pocs\\virtualclinic\\app.log';
        const entry = `${new Date().toISOString()} [VoiceSend] ${msg}\n`;
        try {
            fs.appendFileSync(logPath, entry);
        } catch {
             fs.appendFileSync(fallbackPath, entry);
        }
    } catch (e) {
    }
}

export async function handler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const id = request.params?.id;
    logVoiceSend(`Hit handler for ${id}`); 
    
    if (!id) return { status: 400, jsonBody: { error: 'Missing consult id' } };

    try {
        const active = SessionManager.get(id);
        
        if (!active) {
            logVoiceSend(`No active session found for ${id}. Available: ${SessionManager.listKeys().join(', ')}`);
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
            logToDebug(`[VoiceSend] Received ${audioData.byteLength} bytes for consult ${id}. Sending to VoiceLive...`);
            // Send to session
            await sendAudioInput(active.session, audioData);
        } else {
            context.warn(`[VoiceSend] Received empty body.`);
            logToDebug(`[VoiceSend] Received empty body for consult ${id}.`);
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
