import { CloudWatchLogsClient, CreateLogStreamCommand, PutLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import type { MatchResult } from '@bb-tournament/shared';

/**
 * Same shape as MatchResult, but with the three team-id fields swapped for coach names — this is
 * what actually gets written to the log, so the exported .txt is readable on its own without
 * having to cross-reference team ids against the tournament data. Built by toMatchResultLogView.
 */
export interface MatchResultLogView
  extends Omit<MatchResult, 'concededByTeamId' | 'submittedByTeamId' | 'confirmedByTeamId'> {
  concededBy: string | null;
  submittedBy: string;
  confirmedBy: string | null;
}

/** Resolves a MatchResult's team-id fields to coach names for logging (see MatchResultLogView). */
export function toMatchResultLogView(
  result: MatchResult,
  teamIdToCoachName: (teamId: string) => string
): MatchResultLogView {
  const { concededByTeamId, submittedByTeamId, confirmedByTeamId, ...rest } = result;
  return {
    ...rest,
    concededBy: concededByTeamId ? teamIdToCoachName(concededByTeamId) : null,
    submittedBy: teamIdToCoachName(submittedByTeamId),
    confirmedBy: confirmedByTeamId ? teamIdToCoachName(confirmedByTeamId) : null,
  };
}

const cloudwatchLogs = new CloudWatchLogsClient({});

/**
 * Every match-sheet event is written to this ONE fixed log stream — via explicit PutLogEvents,
 * not console.log — instead of landing in whichever per-invocation stream console.log happens to
 * write to. The Lambda's main log stream(s) also carry a START/END/REPORT entry for literally
 * every invocation, including every 60s poll from every open page; scanning that whole volume
 * (even filtered to one tournament) was slow enough to time the download request out entirely.
 * Restricting the download's FilterLogEvents call to just this stream (see handlers/logs.ts)
 * means it only ever scans the match-sheet events themselves, regardless of overall site traffic.
 */
export const MATCH_SHEET_LOG_STREAM_NAME = 'match-sheet-events';

export function apiFunctionLogGroupName(): string {
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!functionName) throw new Error('AWS_LAMBDA_FUNCTION_NAME env var is not set');
  return `/aws/lambda/${functionName}`;
}

async function putOnce(message: string): Promise<void> {
  await cloudwatchLogs.send(
    new PutLogEventsCommand({
      logGroupName: apiFunctionLogGroupName(),
      logStreamName: MATCH_SHEET_LOG_STREAM_NAME,
      logEvents: [{ message, timestamp: Date.now() }],
    })
  );
}

/**
 * Audit trail for every match-sheet event: "[TID:<id>] <tournament name> - <team1> vs <team2> -
 * <who/what submitted> - <match sheet>" (the `[TID:<id>]` tag is what the download endpoint
 * filters on, names aren't guaranteed unique). The match sheet itself is a MatchResultLogView
 * (see toMatchResultLogView) — coach names, not team ids, so the exported .txt is self-contained.
 * Deliberately swallows its own errors (logging a console.error instead of throwing) — a transient
 * CloudWatch hiccup while writing the audit trail shouldn't fail the actual result submission,
 * which has already been saved successfully by the time this runs. Callers still `await` it rather
 * than firing-and-forgetting, since Lambda can freeze the execution environment right after the
 * HTTP response is sent, which would silently drop an un-awaited write.
 */
export async function logMatchSheetEvent(
  tournamentId: string,
  tournamentName: string,
  team1CoachName: string,
  team2CoachName: string,
  action: string,
  result: MatchResultLogView | null
): Promise<void> {
  const message = `[TID:${tournamentId}] ${tournamentName} - ${team1CoachName} vs ${team2CoachName} - ${action} - ${JSON.stringify(result)}`;
  try {
    await putOnce(message);
  } catch (e: any) {
    if (e.name !== 'ResourceNotFoundException') {
      console.error('Failed to write match-sheet log', e);
      return;
    }
    try {
      await cloudwatchLogs.send(
        new CreateLogStreamCommand({
          logGroupName: apiFunctionLogGroupName(),
          logStreamName: MATCH_SHEET_LOG_STREAM_NAME,
        })
      );
      await putOnce(message);
    } catch (e2: any) {
      if (e2.name !== 'ResourceAlreadyExistsException') {
        console.error('Failed to write match-sheet log (after creating log stream)', e2);
      } else {
        // Lost a race with another concurrent invocation creating the same stream — safe to retry once more.
        try {
          await putOnce(message);
        } catch (e3) {
          console.error('Failed to write match-sheet log (after stream creation race)', e3);
        }
      }
    }
  }
}
