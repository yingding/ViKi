import { z } from 'zod';

const envSchema = z.object({
  NETSFERE_EMAIL: z.string().email(),
  NETSFERE_PASSWORD: z.string().min(8),
  NETSFERE_ORG_ID: z.string().min(1),
  NETSFERE_AUTH_KEY: z.string().min(1),
  AzureWebJobsStorage: z.string().min(1),
  CONSULT_CONTAINER: z.string().min(1),
  ATTACHMENT_CONTAINER: z.string().min(1),
  OPENAI_RESOURCE_NAME: z.string().min(1),
  OPENAI_REALTIME_DEPLOYMENT: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_API_VERSION: z.string().min(1),
  OPENAI_VOICE: z.string().min(1).optional().default('alloy'),
  FOUNDRY_RESOURCE_ENDPOINT: z.string().min(1),
  VOICELIVE_REALTIME_DEPLOYMENT: z.string().min(1)
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | undefined;

export function getEnv(): Env {
  if (!cachedEnv) {
    cachedEnv = envSchema.parse(process.env);
  }
  return cachedEnv;
}
