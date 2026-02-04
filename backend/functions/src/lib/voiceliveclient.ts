
import { VoiceLiveClient, VoiceLiveSession } from '@azure/ai-voicelive';
//import { AzureKeyCredential} from '@azure/core-auth';
import { DefaultAzureCredential } from "@azure/identity";
import { getEnv } from './env';
import type { StoredConsult } from './consultRepository';

export async function createVoiceLiveSession(consult: StoredConsult, callbacks?: { 
  onAudioData?: (data: Uint8Array) => void;
  onInputStarted?: () => void;
}): Promise<VoiceLiveSession> {
  const env = getEnv();

  // MOCK MODE: If endpoint contains "mock" or if forced
  if (env.FOUNDRY_RESOURCE_ENDPOINT.includes('mock') || process.env.USE_MOCK_VOICE === 'true') {
      console.log(' [VoiceLive] Using MOCK Session');
      return createMockSession(callbacks);
  }

  const endpoint = env.FOUNDRY_RESOURCE_ENDPOINT;
  const credential = new DefaultAzureCredential();
  
  // Create the VoiceLive client
  let session;
  try {
      console.log(`[VoiceLive] Connect: Initializing client for ${endpoint}`);
      const client = new VoiceLiveClient(endpoint, credential);
      
      console.log(`[VoiceLive] Connect: Calling startSession('${env.VOICELIVE_REALTIME_DEPLOYMENT}')...`);
      const startTime = Date.now();
      session = await client.startSession(env.VOICELIVE_REALTIME_DEPLOYMENT);
      console.log(`[VoiceLive] Connect: Connected successfully in ${Date.now() - startTime}ms`);
  } catch (err: any) {
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
      threshold: 0.5,
    },
    inputAudioFormat: 'pcm16',
    outputAudioFormat: 'pcm16',
    tools: tools,
    toolChoice: "auto",
  });

  // Handle function calls
  session.subscribe({
    onResponseFunctionCallArgumentsDone: async (event, context) => {
      if (event.name === "get_weather") {
        console.log(`[Tool Call] get_weather called with arguments: ${event.arguments}`);
        const args = JSON.parse(event.arguments);
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
    },
    onResponseAudioDelta: async (event, context) => {
      // Handle incoming audio chunks
      if (callbacks?.onAudioData) {
        callbacks.onAudioData(event.delta);
      }
    },

    // Handle user speech start (barge-in)
    onInputAudioBufferSpeechStarted: async (event, context) => {
       console.log(" [Speech Started Detected] ");
       if (callbacks?.onInputStarted) {
         callbacks.onInputStarted();
       }
    },

    onResponseTextDelta: async (event, context) => {
      // Handle incoming text deltas
      console.log("Assistant:", event.delta);
    },

    onConversationItemInputAudioTranscriptionCompleted: async (event, context) => {
      // Handle user speech transcription
      console.log("User said:", event.transcript);
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
