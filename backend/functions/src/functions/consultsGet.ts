import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getConsult } from '../lib/consultRepository';

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

    return {
      status: 200,
      jsonBody: consult
    };
  } catch (error) {
    context.error(`Failed to load consult ${id}`, error);
    return {
      status: 500,
      jsonBody: { error: 'Unable to retrieve consult' }
    };
  }
}

app.http('consults-get', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'consults/{id}',
  handler
});
