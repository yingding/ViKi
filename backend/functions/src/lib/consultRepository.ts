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

export async function listConsults(): Promise<StoredConsultSummary[]> {
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

  // sort newest first
  return summaries.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

export async function getConsult(id: string): Promise<StoredConsult | undefined> {
  const container = await ensureContainer();
  const blobClientRef = container.getBlockBlobClient(`${id}.json`);
  if (!(await blobClientRef.exists())) {
    return undefined;
  }
  const download = await blobClientRef.download();
  const body = await streamToString(download.readableStreamBody);
  return JSON.parse(body) as StoredConsult;
}

async function streamToString(readable: NodeJS.ReadableStream | undefined) {
  if (!readable) {
    return '';
  }
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}
