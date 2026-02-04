import { BlobServiceClient, BlockBlobUploadOptions } from '@azure/storage-blob';
import { getEnv } from './env';
import type { NetsfereMessage } from './netsfereClient';

function getContainerClient() {
  const env = getEnv();
  const blobClient = BlobServiceClient.fromConnectionString(env.AzureWebJobsStorage);
  return blobClient.getContainerClient(env.CONSULT_CONTAINER);
}

export type StoredConsult = {
  id: string;
  convId: number;
  msgId: number;
  senderEmail?: string;
  receivedAt: string;
  payload: NetsfereMessage;
};

export type StoredConsultSummary = {
  id: string;
  senderEmail?: string;
  receivedAt: string;
  snippet: string;
  msgType: string;
};

async function ensureContainer() {
  const container = getContainerClient();
  await container.createIfNotExists();
  return container;
}

export async function saveConsult(record: StoredConsult) {
  const container = await ensureContainer();

  const blobName = `${record.id}.json`;
  const blockBlob = container.getBlockBlobClient(blobName);
  const body = JSON.stringify(record);
  const options: BlockBlobUploadOptions = {
    blobHTTPHeaders: { blobContentType: 'application/json' },
    metadata: {
      sender: record.senderEmail ?? '',
      receivedat: record.receivedAt,
      msgtype: record.payload.msgType ?? 'text',
      snippet: record.payload.msgText?.slice(0, 256) ?? ''
    }
  };

  await blockBlob.upload(body, Buffer.byteLength(body), options);
}

async function streamToString(readable: NodeJS.ReadableStream | undefined) {
  if (!readable) {
    return '';
  }
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks as Uint8Array[]).toString('utf-8');
}

// --- MOCK DATA FOR LOCAL DEV ---
const MOCK_CONSULTS: StoredConsult[] = [
  {
    id: "0-0",
    convId: 0,
    msgId: 0,
    senderEmail: "admin@system.local",
    receivedAt: new Date().toISOString(),
    payload: {
        msgId: 0,
        convId: 0,
        created: Date.now(),
        senderEmail: "admin@system.local",
        msgType: "text",
        msgText: "System Check: This is a placeholder consult for testing connectivity."
    }
  },
  {
    id: "mock-1",
    convId: 101,
    msgId: 201,
    senderEmail: "jane.doe@example.com",
    receivedAt: new Date().toISOString(),
    payload: {
        msgId: 201,
        convId: 101,
        created: Date.now(),
        senderEmail: "jane.doe@example.com",
        msgType: "text",
        msgText: "Patient reports persistent migraine for 3 days. Photophobia present. No history of neurological issues."
    }
  },
  {
    id: "mock-2",
    convId: 102,
    msgId: 202,
    senderEmail: "cardiology@hospital.com",
    receivedAt: new Date(Date.now() - 86400000).toISOString(),
    payload: {
        msgId: 202,
        convId: 102,
        created: Date.now() - 86400000,
        senderEmail: "cardiology@hospital.com",
        msgType: "text",
        msgText: "ECG results for Mr. Smith attached. Signs of AFib. Please review urgency."
    }
  }
];

export async function listConsults(): Promise<StoredConsultSummary[]> {
  try {
    const container = await ensureContainer();
    const summaries: StoredConsultSummary[] = [];

    for await (const blob of container.listBlobsFlat()) {
      const metadata = blob.metadata ?? {};
      summaries.push({
        id: blob.name.replace('.json', ''),
        senderEmail: metadata.sender || undefined,
        receivedAt: metadata.receivedat || blob.properties?.createdOn?.toISOString() || new Date().toISOString(),
        snippet: metadata.snippet || '',
        msgType: metadata.msgtype || 'text'
      });
    }

    if (summaries.length > 0) {
        return summaries.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    }
  } catch (err) {
      console.warn("Could not list blobs, falling back to mocks", err);
  }

  // Fallback to mocks if empty or error
  return MOCK_CONSULTS.map(c => ({
      id: c.id,
      senderEmail: c.senderEmail,
      receivedAt: c.receivedAt,
      snippet: c.payload.msgText?.slice(0, 100) || '',
      msgType: c.payload.msgType || 'text'
  }));
}

export async function getConsult(id: string): Promise<StoredConsult | undefined> {
  console.log(`[ConsultRepository] getConsult(${id}) called`);
  const mock = MOCK_CONSULTS.find(c => c.id === id);
  if (mock) {
     console.log(`[ConsultRepository] Returning mock consult for ${id}`);
     return mock;
  }

  console.log(`[ConsultRepository] Checking Azure Storage for ${id}...`);
  const container = await ensureContainer();
  const blobClientRef = container.getBlockBlobClient(`${id}.json`);
  if (!(await blobClientRef.exists())) {
    return undefined;
  }
  const download = await blobClientRef.download();
  const body = await streamToString(download.readableStreamBody);
  return JSON.parse(body) as StoredConsult;
}
