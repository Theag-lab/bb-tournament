import { CopyObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Tournament, TournamentBackupSummary } from '@bb-tournament/shared';
import { conflict, notFound } from './errors';

const s3 = new S3Client({});
const BUCKET = process.env.DATA_BUCKET_NAME;

// A backup's object key (`<id>-bkp-<N>.json`) is deliberately indistinguishable, to objectKey,
// from any other tournament's — every route/handler keys purely off whatever id string it's
// given, so a backup works as its own fully independent, writable "tournament" simply by using
// `<id>-bkp-<N>` as the id everywhere (e.g. GET/admin mutations on it never touch the original).
// There's no dedicated "read a backup" codepath for that reason; the frontend just navigates to
// the normal admin/public routes with that composite id (see frontend/src/app/core/backup.ts).
function objectKey(tournamentId: string): string {
  return `tournaments/${tournamentId}.json`;
}

function backupPrefix(tournamentId: string): string {
  return `tournaments/${tournamentId}-bkp-`;
}

function backupObjectKey(tournamentId: string, index: number): string {
  return `${backupPrefix(tournamentId)}${index}.json`;
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

/** Every manual backup for this tournament, most recent (highest index) first. */
export async function listBackups(id: string): Promise<TournamentBackupSummary[]> {
  const prefix = backupPrefix(id);
  const summaries: TournamentBackupSummary[] = [];
  let continuationToken: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: bucketName(), Prefix: prefix, ContinuationToken: continuationToken })
    );
    for (const obj of res.Contents ?? []) {
      const suffix = obj.Key?.slice(prefix.length).replace(/\.json$/, '');
      const index = suffix ? Number(suffix) : NaN;
      if (Number.isInteger(index) && obj.LastModified) {
        summaries.push({ index, createdAt: obj.LastModified.toISOString() });
      }
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return summaries.sort((a, b) => b.index - a.index);
}

/** One past the highest `<id>-bkp-<N>.json` already in the bucket (1 if there are none yet). */
async function nextBackupIndex(id: string): Promise<number> {
  const backups = await listBackups(id);
  return backups.reduce((max, b) => Math.max(max, b.index), 0) + 1;
}

/**
 * Manual snapshot of the tournament's current S3 object, named `<id>-bkp-<N>.json` (N one past
 * the highest backup index already present) — replaces S3 object versioning, which kept a
 * noncurrent version on every single write and accumulated far too many objects. Taken right
 * before a round launches (see rounds.launch), and also available on demand (see
 * handlers/backups.ts), so there's always a restore point for "the tournament exactly as it stood
 * at this moment".
 */
export async function backupTournament(id: string): Promise<TournamentBackupSummary> {
  const index = await nextBackupIndex(id);
  await s3.send(
    new CopyObjectCommand({
      Bucket: bucketName(),
      CopySource: `${bucketName()}/${objectKey(id)}`,
      Key: backupObjectKey(id, index),
    })
  );
  return { index, createdAt: new Date().toISOString() };
}
