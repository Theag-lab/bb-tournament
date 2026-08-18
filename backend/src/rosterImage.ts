import type { Context } from 'hono';
import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import {
  ROSTER_IMAGE_ALLOWED_CONTENT_TYPES,
  ROSTER_IMAGE_MAX_SIZE_BYTES,
  type RosterImageUploadUrlRequest,
  type RosterImageUploadUrlResponse,
} from '@bb-tournament/shared';
import * as storage from './storage';
import { authenticateTeam, isAdmin } from './auth';
import { toPublicTournament } from './sanitize';
import { badRequest, notFound } from './errors';

const s3 = new S3Client({});
const UPLOAD_URL_EXPIRY_SECONDS = 300;

export function assetsBucketName(): string {
  const bucket = process.env.ASSETS_BUCKET_NAME;
  if (!bucket) throw new Error('ASSETS_BUCKET_NAME env var is not set');
  return bucket;
}

export function rosterImageKey(tournamentId: string, teamId: string): string {
  return `roster-images/${tournamentId}/${teamId}`;
}

function assertOwnsTeam(
  tournament: Parameters<typeof isAdmin>[0],
  teamId: string,
  password: string | undefined,
  token: string | undefined
): void {
  if (isAdmin(tournament, token)) {
    if (!tournament.teams.some((t) => t.id === teamId)) throw notFound('Team not found');
    return;
  }
  authenticateTeam(tournament, teamId, password);
}

export async function getUploadUrl(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const teamId = c.req.param('teamId')!;
  const password = c.req.query('password');
  const token = c.req.query('token');
  const body = await c.req.json<RosterImageUploadUrlRequest>().catch(() => null);
  const contentType = body?.contentType;
  if (!contentType || !(ROSTER_IMAGE_ALLOWED_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    throw badRequest(`contentType must be one of: ${ROSTER_IMAGE_ALLOWED_CONTENT_TYPES.join(', ')}`);
  }

  const tournament = await storage.getTournament(tournamentId);
  assertOwnsTeam(tournament, teamId, password, token);

  const { url, fields } = await createPresignedPost(s3, {
    Bucket: assetsBucketName(),
    Key: rosterImageKey(tournamentId, teamId),
    Conditions: [
      ['content-length-range', 0, ROSTER_IMAGE_MAX_SIZE_BYTES],
      ['eq', '$Content-Type', contentType],
    ],
    Fields: { 'Content-Type': contentType },
    Expires: UPLOAD_URL_EXPIRY_SECONDS,
  });

  const response: RosterImageUploadUrlResponse = { url, fields };
  return c.json(response);
}

export async function confirmUpload(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const teamId = c.req.param('teamId')!;
  const password = c.req.query('password');
  const token = c.req.query('token');

  await storage.updateTournament(tournamentId, (t) => {
    assertOwnsTeam(t, teamId, password, token);
    const team = t.teams.find((tm) => tm.id === teamId);
    if (!team) throw notFound('Team not found');
    team.rosterImage = { updatedAt: new Date().toISOString() };
  });

  const tournament = await storage.getTournament(tournamentId);
  return c.json(toPublicTournament(tournament));
}
