import type { Context } from 'hono';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import * as storage from '../storage';
import { requireAdmin } from '../auth';
import { MATCH_SHEET_LOG_STREAM_NAME, apiFunctionLogGroupName } from '../matchSheetLog';

const cloudwatchLogs = new CloudWatchLogsClient({});
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // last week

// Belt-and-suspenders: restricting FilterLogEvents to the one dedicated match-sheet-events stream
// (see matchSheetLog.ts) should already make this fast regardless of overall site traffic, but
// stopping well under the function's own timeout (see the CDK stack) means a download still
// returns a real response — truncated, if there was ever still too much to page through in time —
// instead of risking getting killed mid-request.
const TIME_BUDGET_MS = 20_000;

/**
 * Downloads this tournament's own match-sheet submission logs (see matchSheetLog.ts) as a
 * plain-text file — filtered to lines tagged `[TID:<thisTournamentId>]` (the dedicated log stream
 * holds every tournament's events) and to the last 7 days. Each line is prefixed with the ISO
 * timestamp of when the event was logged (i.e. when the action happened, not the in-game
 * `playedAt` date already carried inside the match sheet JSON).
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
        logGroupName: apiFunctionLogGroupName(),
        logStreamNames: [MATCH_SHEET_LOG_STREAM_NAME],
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
  const lines = events.map((e) => `${new Date(e.timestamp).toISOString()} ${e.message}`);
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
