
import { VoiceLiveClient, VoiceLiveSession } from '@azure/ai-voicelive';
//import { AzureKeyCredential} from '@azure/core-auth';
import { DefaultAzureCredential } from "@azure/identity";
import { getEnv } from './env';
import type { StoredConsult } from './consultRepository';
import * as fs from 'fs';
import * as path from 'path';

export function logToDebug(msg: string) {
  try {
    // Separate log file to avoid Azurite lock contention
    const logPath = path.resolve(process.cwd(), '../../app.log');
    
    // Fallback if CWD is weird
    const fallbackPath = 'C:\\Users\\yingdingwang\\Documents\\VCS\\pocs\\virtualclinic\\app.log';
    
    const entry = `${new Date().toISOString()} [VoiceLiveClient] ${msg}\n`;
    
    try {
        fs.appendFileSync(logPath, entry);
    } catch {
        fs.appendFileSync(fallbackPath, entry);
    }
  } catch(e) {
     // console.error(e);
  }
}

export async function createVoiceLiveSession(consult: StoredConsult, callbacks?: { 
  onAudioData?: (data: Uint8Array) => void;
  onInputStarted?: () => void;
}, options?: {
  vadThreshold?: number;
}): Promise<VoiceLiveSession> {
  const env = getEnv();

  // MOCK MODE: If endpoint contains "mock" or if forced
  if (env.FOUNDRY_RESOURCE_ENDPOINT.includes('mock') || process.env.USE_MOCK_VOICE === 'true') {
      logToDebug('Using MOCK Session (forced or mock endpoint)');
      return createMockSession(callbacks);
  }

  const endpoint = env.FOUNDRY_RESOURCE_ENDPOINT;
  const credential = new DefaultAzureCredential();
  
  // Create the VoiceLive client
  let session;
  try {
      logToDebug(`Connect: Initializing client for ${endpoint}`);
      const client = new VoiceLiveClient(endpoint, credential);
      
      logToDebug(`Connect: Calling startSession('${env.VOICELIVE_REALTIME_DEPLOYMENT}')...`);
      const startTime = Date.now();
      session = await client.startSession(env.VOICELIVE_REALTIME_DEPLOYMENT);
      logToDebug(`Connect: Connected successfully in ${Date.now() - startTime}ms`);
  } catch (err: any) {
      logToDebug(`Connection failed (${err.message}). Falling back to MOCK session.`);
      console.warn(`[VoiceLive] Connection failed (${err.message}). Falling back to MOCK session.`);
      return createMockSession(callbacks);
  }

  // Define available functions
  const tools = [
    {
      type: "function",
      name: "get_weather",
      description: "Get current weather for a location",
      parameters: {
        type: "object",
        properties: {
          location: {
            type: "string",
            description: "The city and state or country",
          },
        },
        required: ["location"],
      },
    },
  ];

  // Configure session with tools
  await session.updateSession({
    modalities: ["text", "audio"],
    instructions: "You are ViKi, a virtual pediatric specialist. Help with consults and use tools when needed.",
    voice: {
      type: 'azure-standard',
      name: 'en-US-AvaNeural',
    },
    turnDetection: {
      type: 'server_vad',
      threshold: options?.vadThreshold ?? 0.5,
    },
    inputAudioFormat: 'pcm16',
    outputAudioFormat: 'pcm16',
    tools: tools,
    toolChoice: "auto",
  });

  // Handle function calls
  session.subscribe({
    onResponseFunctionCallArgumentsDone: async (event, context) => {
      try {
        if (event.name === "get_weather") {
            console.log(`[Tool Call] get_weather called with arguments: '${event.arguments}'`);
            let args: any = {};
            if (event.arguments && event.arguments.trim().length > 0) {
                try {
                    args = JSON.parse(event.arguments);
                } catch (e) {
                    console.error("Failed to parse arguments:", event.arguments);
                    throw new Error("Invalid JSON arguments");
                }
            }

            if (!args.location) {
                throw new Error("Missing required argument: location");
            }
            
            const weatherData = await getWeatherData(args.location);
            console.log(`[Tool Result] Returning:`, JSON.stringify(weatherData));

            // Send function result back
            await session.addConversationItem({
            type: "function_call_output",
            callId: event.callId,
            output: JSON.stringify(weatherData),
            } as any);

            // Request response generation
            await session.sendEvent({
            type: "response.create",
            });
        }
      } catch (error: any) {
          console.error(`[Tool Call] Error processing ${event.name}:`, error);
          // Send error back to help model recover
          try {
            await session.addConversationItem({
                type: "function_call_output",
                callId: event.callId,
                output: JSON.stringify({ error: "Failed to execute tool: " + error.message }),
            } as any);
            await session.sendEvent({ type: "response.create" });
          } catch (innerError) {
              console.error("Failed to report error to session:", innerError);
          }
      }
    },
    onResponseAudioDelta: async (event, context) => {
      // Handle incoming audio chunks
      if (callbacks?.onAudioData) {
        callbacks.onAudioData(event.delta);
      }
    },

    // Handle user speech start (barge-in)
    onInputAudioBufferSpeechStarted: async (event, context) => {
       logToDebug(" [Speech Started Detected] ");
       if (callbacks?.onInputStarted) {
         callbacks.onInputStarted();
       }
    },

    onResponseTextDelta: async (event, context) => {
      // Handle incoming text deltas
      logToDebug("Assistant: " + event.delta);
    },

    onConversationItemInputAudioTranscriptionCompleted: async (event, context) => {
      // Handle user speech transcription
      logToDebug("User said: " + event.transcript);
    },
  });

  // Example of sending audio data:
  // function sendAudioChunk(audioBuffer: ArrayBuffer) {
  //   session.sendAudio(audioBuffer);
  // }

  return session;
}

function buildContextFromConsult(consult: StoredConsult) {
  const preview = consult.payload.msgText?.slice(0, 400) ?? 'No text body was provided.';
  return `You are ViKi, a virtual pediatric specialist supporting asynchronous consults. Use the following context to answer with precision and keep replies concise.\n\nConsult ID: ${consult.id}\nSender: ${consult.senderEmail ?? 'unknown'}\nReceived: ${consult.receivedAt}\nMessage Type: ${consult.payload.msgType}\nMessage Preview: ${preview}`;
}

async function getWeatherData(location: string) {
  // Mock weather data
  return {
    location,
    temperature: 72,
    unit: 'F',
    condition: 'Sunny'
  };
}

/**
 * Sends audio input to the VoiceLive session.
 * @param session The active VoiceLive session.
 * @param audioData The audio data to send.
 */
export async function sendAudioInput(session: VoiceLiveSession, audioData: ArrayBuffer | Uint8Array) {
  logToDebug(`Sending ${audioData.byteLength} bytes to VoiceLive session`);
  
  // Debug: Write audio to file to verify quality/rate
  try {
      const debugPcmPath = path.resolve(process.cwd(), '../../debug_received.pcm');
      fs.appendFileSync(debugPcmPath, new Uint8Array(audioData));
  } catch(e) {}

  await session.sendAudio(audioData);
}

// --- MOCK SESSION ---
function createMockSession(callbacks?: { 
    onAudioData?: (data: Uint8Array) => void;
    onInputStarted?: () => void;
  }): any {
    return {
        isConnected: true,
        dispose: async () => { console.log('[MockSession] Disposed'); },
        sendAudio: async (data: Uint8Array) => {
            // Simple Echo with delay
            console.log(`[MockSession] Received ${data.byteLength} bytes. Echoing directly...`);
            if (callbacks?.onAudioData) {
                // Echo back immediately to verify loop
                // In real world, we would wait for VAD
                callbacks.onAudioData(data);
            } else {
                 console.warn('[MockSession] No onAudioData callback registered!');
            }
        },
        updateSession: async () => {},
        subscribe: () => {},
        addConversationItem: async () => {},
        sendEvent: async () => {}
    };
}
