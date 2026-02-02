import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getConsult } from '../lib/consultRepository';
import { createRealtimeSession } from '../lib/openAiRealtime';

async function handler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const id = request.params?.id;

  if (!id) {
    return {
      status: 400,
      jsonBody: { error: 'Missing consult id' }
    };
  }

  try {
    const consult = await getConsult(id);
    if (!consult) {
      return {
        status: 404,
        jsonBody: { error: 'Consult not found' }
      };
    }

    const session = await createRealtimeSession(consult);

    return {
      status: 200,
      jsonBody: session
    };
  } catch (error) {
    context.error(`Failed to create realtime session for consult ${id}`, error);
    return {
      status: 500,
      jsonBody: { error: 'Unable to create realtime session' }
    };
  }
}

app.http('consult-voice-token', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'consults/{id}/voice-token',
  handler
});
