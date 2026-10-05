import type { Context } from 'hono';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import * as storage from '../storage';
import { requireAdmin } from '../auth';

const cloudwatchLogs = new CloudWatchLogsClient({});
const LOOKBACK_MS = 24 * 60 * 60 * 1000; // last day only

// This Lambda's log group holds every invocation's logs, for every tournament, including every
// 60s poll from every open page — scanning even just a day of that can take a while (a full week
// is what originally caused a real Lambda timeout, which bypasses our own error handling entirely
// and shows up to the browser as a bare "Internal Server Error" with nothing obviously useful in
// CloudWatch). Stopping well under the function's own timeout (see the CDK stack) means we always
// return a real response — truncated, if there was too much to fully page through in time —
// instead of risking getting killed mid-request.
const TIME_BUDGET_MS = 20_000;

function logGroupName(): string {
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!functionName) throw new Error('AWS_LAMBDA_FUNCTION_NAME env var is not set');
  return `/aws/lambda/${functionName}`;
}

/**
 * Downloads this tournament's own match-sheet submission logs (see challenges.ts'
 * logMatchSheetEvent) as a plain-text file, from CloudWatch — the Lambda's log group is shared
 * across every tournament, so this filters to lines tagged `[TID:<thisTournamentId>]` and to the
 * last 24h only (CloudWatch's default retention here is longer, but older entries aren't what
 * an admin chasing down "what happened recently" wants anyway — and keeping the lookback short
 * keeps this fast, see the TIME_BUDGET_MS comment below).
 */
export async function downloadMatchSheetLogs(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const token = c.req.query('token');

  const tournament = await storage.getTournament(tournamentId);
  requireAdmin(tournament, token);

  const events: { timestamp: number; message: string }[] = [];
  let nextToken: string | undefined;
  let truncated = false;
  const startTime = Date.now() - LOOKBACK_MS;
  const deadline = Date.now() + TIME_BUDGET_MS;
  do {
    const res = await cloudwatchLogs.send(
      new FilterLogEventsCommand({
        logGroupName: logGroupName(),
        filterPattern: `"[TID:${tournamentId}]"`,
        startTime,
        nextToken,
      })
    );
    for (const event of res.events ?? []) {
      if (event.message !== undefined && event.timestamp !== undefined) {
        events.push({ timestamp: event.timestamp, message: event.message.trimEnd() });
      }
    }
    nextToken = res.nextToken;
    if (nextToken && Date.now() > deadline) {
      truncated = true;
      break;
    }
  } while (nextToken);

  events.sort((a, b) => a.timestamp - b.timestamp);
  const lines = events.map((e) => e.message);
  if (truncated) {
    lines.push(
      '',
      "[Export tronqué : trop de volume de logs à parcourir en une requête — relancez le téléchargement pour continuer à partir d'un peu plus tôt si besoin.]"
    );
  }
  const body = lines.length > 0 ? lines.join('\n') + '\n' : '';

  const filename = tournamentId.replace(/[^a-zA-Z0-9-_]+/g, '_') || 'tournoi';
  return c.body(body, 200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}-feuilles-de-match.txt"`,
  });
}
