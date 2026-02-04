import { VoiceLiveSession } from '@azure/ai-voicelive';

interface ActiveSession {
    session: VoiceLiveSession;
    consultId: string;
    outputController: ReadableStreamDefaultController<any> | null;
    lastActivity: number;
}


// In-memory store for local development MVP
// accessible by all function invocations in the same process
const sessions = new Map<string, ActiveSession>();

export const SessionManager = {
    register: (consultId: string, session: VoiceLiveSession) => {
        sessions.set(consultId, {
            session,
            consultId,
            outputController: null,
            lastActivity: Date.now()
        });
        console.log(`[SessionManager] Registered session for ${consultId}`);
    },

    get: (consultId: string) => {
        const s = sessions.get(consultId);
        if (s) s.lastActivity = Date.now();
        return s;
    },

    remove: async (consultId: string) => {
        const s = sessions.get(consultId);
        if (s) {
            try {
                // If we have an active controller, close it to end the GET stream
                if (s.outputController) {
                    try { s.outputController.close(); } catch (e) { /* ignore */ }
                }
                await s.session.dispose();
            } catch (e) {
                console.error(`[SessionManager] Error disposing session ${consultId}`, e);
            }
            sessions.delete(consultId);
        }
    },

    attachController: (consultId: string, controller: ReadableStreamDefaultController<any>) => {
        const s = sessions.get(consultId);
        if (s) {
            s.outputController = controller;
            console.log(`[SessionManager] Controller attached to ${consultId}`);
        }
    },

    detachController: (consultId: string) => {
        const s = sessions.get(consultId);
        if (s) {
            s.outputController = null;
            console.log(`[SessionManager] Controller detached from ${consultId}`);
        }
    }
};
