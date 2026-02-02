import axios from 'axios';
import { z } from 'zod';
import { getEnv } from './env';

export type NetsfereMessage = {
  msgId: number;
  convId: number;
  created: number;
  senderEmail: string;
  msgType: string;
  msgText: string;
  attachment?: {
    attachmentId: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
  } | null;
};

const netsfereBaseUrl = process.env.NETSFERE_BASE_URL ?? 'https://api.netsfere.com';

const webhookPayloadSchema = z.object({
  convId: z.number().int(),
  msgId: z.number().int(),
  senderEmail: z.string().email().optional(),
  msgText: z.string().optional(),
  msgType: z.string().optional()
});

export type NetsfereWebhookPayload = z.infer<typeof webhookPayloadSchema>;

export function parseWebhookPayload(body: unknown): NetsfereWebhookPayload {
  return webhookPayloadSchema.parse(body);
}

export async function fetchMessageDetails(payload: NetsfereWebhookPayload): Promise<NetsfereMessage | undefined> {
  const env = getEnv();

  const response = await axios.post(
    `${netsfereBaseUrl}/get`,
    new URLSearchParams({
      email: env.NETSFERE_EMAIL,
      password: env.NETSFERE_PASSWORD,
      convId: String(payload.convId),
      msgId: String(payload.msgId)
    }),
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000
    }
  );

  if (!Array.isArray(response.data) || response.data.length === 0) {
    return undefined;
  }

  const latest = response.data[response.data.length - 1] as NetsfereMessage;
  return latest;
}
