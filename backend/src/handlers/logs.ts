import type { Context } from 'hono';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import * as storage from '../storage';
import { requireAdmin } from '../auth';

const cloudwatchLogs = new CloudWatchLogsClient({});
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // last week only

function logGroupName(): string {
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!functionName) throw new Error('AWS_LAMBDA_FUNCTION_NAME env var is not set');
  return `/aws/lambda/${functionName}`;
}

/**
 * Downloads this tournament's own match-sheet submission logs (see challenges.ts'
 * logMatchSheetEvent) as a plain-text file, from CloudWatch — the Lambda's log group is shared
 * across every tournament, so this filters to lines tagged `[TID:<thisTournamentId>]` and to the
 * last 7 days only (CloudWatch's default retention here is longer, but older entries aren't what
 * an admin chasing down "what happened this week" wants anyway).
 */
export async function downloadMatchSheetLogs(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const token = c.req.query('token');

  const tournament = await storage.getTournament(tournamentId);
  requireAdmin(tournament, token);

  const events: { timestamp: number; message: string }[] = [];
  let nextToken: string | undefined;
  const startTime = Date.now() - LOOKBACK_MS;
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
  } while (nextToken);

  events.sort((a, b) => a.timestamp - b.timestamp);
  const body = events.map((e) => e.message).join('\n') + (events.length > 0 ? '\n' : '');

  const filename = tournamentId.replace(/[^a-zA-Z0-9-_]+/g, '_') || 'tournoi';
  return c.body(body, 200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}-feuilles-de-match.txt"`,
  });
}
