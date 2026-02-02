import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { fetchMessageDetails, parseWebhookPayload, type NetsfereMessage } from '../lib/netsfereClient';
import { saveConsult } from '../lib/consultRepository';

async function handler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const body = await request.json();

    context.log('Received NetSfere webhook payload', body);

    const payload = parseWebhookPayload(body);
    let message: NetsfereMessage | undefined;

    try {
      message = await fetchMessageDetails(payload);
    } catch (error) {
      context.warn(`Failed to fetch NetSfere message for convId=${payload.convId} msgId=${payload.msgId}`, error);
    }

    if (!message) {
      context.warn(
        `Falling back to webhook payload for convId=${payload.convId} msgId=${payload.msgId}; ensure NetSfere credentials are configured.`
      );
      message = {
        msgId: payload.msgId,
        convId: payload.convId,
        created: Date.now(),
        senderEmail: payload.senderEmail ?? 'unknown@netsfere',
        msgType: payload.msgType ?? 'text',
        msgText: payload.msgText ?? 'No message text provided by webhook.',
        attachment: null
      };
    }

    await saveConsult({
      id: `${payload.convId}-${payload.msgId}`,
      convId: payload.convId,
      msgId: payload.msgId,
      senderEmail: payload.senderEmail,
      receivedAt: new Date().toISOString(),
      payload: message
    });
    context.log(`Stored consult ${payload.convId}-${payload.msgId} to blob storage`);

    return {
      status: 202,
      jsonBody: { status: 'stored' }
    };
  } catch (error) {
    context.error('Failed to process NetSfere webhook', error);
    return {
      status: 500,
      jsonBody: { status: 'error', message: 'Unable to process consult' }
    };
  }
}

app.http('netsfere-webhook', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'netsfere/webhook',
  handler
});
