import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Tournament } from '@bb-tournament/shared';
import { conflict, notFound } from './errors';

const s3 = new S3Client({});
const BUCKET = process.env.DATA_BUCKET_NAME;

function objectKey(tournamentId: string): string {
  return `tournaments/${tournamentId}.json`;
}

function bucketName(): string {
  if (!BUCKET) throw new Error('DATA_BUCKET_NAME env var is not set');
  return BUCKET;
}

class S3PreconditionFailed extends Error {}

async function loadTournament(id: string): Promise<{ data: Tournament; etag: string }> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucketName(), Key: objectKey(id) }));
    const body = await res.Body!.transformToString();
    return { data: JSON.parse(body) as Tournament, etag: res.ETag! };
  } catch (e: any) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
      throw notFound(`Tournament ${id} not found`, 'tournament_not_found');
    }
    throw e;
  }
}

async function saveTournament(id: string, data: Tournament, ifMatchEtag: string): Promise<void> {
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucketName(),
        Key: objectKey(id),
        Body: JSON.stringify(data),
        ContentType: 'application/json',
        IfMatch: ifMatchEtag,
      })
    );
  } catch (e: any) {
    if (e.$metadata?.httpStatusCode === 412) {
      throw new S3PreconditionFailed();
    }
    throw e;
  }
}

/** Creates the tournament object, failing if one already exists at this id (UUID collision safety). */
export async function createTournament(data: Tournament): Promise<void> {
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucketName(),
        Key: objectKey(data.id),
        Body: JSON.stringify(data),
        ContentType: 'application/json',
        IfNoneMatch: '*',
      })
    );
  } catch (e: any) {
    if (e.$metadata?.httpStatusCode === 412) {
      throw conflict('Tournament id collision, please retry', 'id_collision');
    }
    throw e;
  }
}

export async function getTournament(id: string): Promise<Tournament> {
  const { data } = await loadTournament(id);
  return data;
}

/**
 * Read-modify-write with optimistic concurrency via S3's conditional PUT (If-Match).
 * The mutator receives the current tournament, may mutate it in place and/or return
 * a value; on an S3 412 (concurrent write) the whole read-mutate-write cycle retries.
 */
export async function updateTournament<T>(
  id: string,
  mutator: (data: Tournament) => T
): Promise<T> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { data, etag } = await loadTournament(id);
    const result = mutator(data);
    try {
      await saveTournament(id, data, etag);
      return result;
    } catch (e) {
      if (e instanceof S3PreconditionFailed && attempt < maxAttempts) continue;
      if (e instanceof S3PreconditionFailed) {
        throw conflict('Tournament was modified concurrently, please retry', 'write_conflict');
      }
      throw e;
    }
  }
  throw conflict('Could not save tournament after multiple attempts', 'write_conflict');
}
