import { RACE_TO_NAF_TEAM, type Challenge, type Team, type Tournament } from './types';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** A team only counts for NAF export if it has a NAF number and a race with a known NAF label. */
function nafTeamLabel(team: Team): string | null {
  if (!team.nafNumber) return null;
  return RACE_TO_NAF_TEAM[team.race as keyof typeof RACE_TO_NAF_TEAM] ?? null;
}

/**
 * Builds the `nafReport` XML export described in inspiration/naf-xml-export-spec.md.
 *
 * Unlike the vendored Tourma app this is reimplementing, `touchDowns`/`badlyHurt` are the
 * team's actual TD/casualty totals for the match, not whatever the tournament's first two
 * scoring criteria happen to be (Tourma's behavior, not a NAF requirement).
 */
export function buildNafExport(tournament: Tournament): string {
  const eligibleTeams = new Map<string, { label: string }>();
  for (const team of tournament.teams) {
    const label = nafTeamLabel(team);
    if (label) eligibleTeams.set(team.id, { label });
  }

  const coachesXml = tournament.teams
    .filter((team) => eligibleTeams.has(team.id))
    .map(
      (team) =>
        `<coach><name>${escapeXml(team.coachName)}</name><number>${escapeXml(team.nafNumber!)}</number><team>${escapeXml(
          eligibleTeams.get(team.id)!.label
        )}</team></coach>`
    )
    .join('\n');

  const gamesXml = tournament.challenges
    .filter((c): c is Challenge & { result: NonNullable<Challenge['result']> } => c.status === 'completed' && c.result !== null)
    .map((c) => {
      const team1 = tournament.teams.find((t) => t.id === c.team1Id);
      const team2 = tournament.teams.find((t) => t.id === c.team2Id);
      if (!team1 || !team2 || !eligibleTeams.has(team1.id) || !eligibleTeams.has(team2.id)) return null;

      const timeStamp = `${c.result.playedAt} 12:00`;
      const playerRecord = (team: Team, td: number, cas: number) =>
        `<playerRecord><name>${escapeXml(team.coachName)}</name><number>${escapeXml(
          team.nafNumber!
        )}</number><teamRating>0</teamRating><touchDowns>${td}</touchDowns><badlyHurt>${cas}</badlyHurt></playerRecord>`;

      return (
        `<game><timeStamp>${escapeXml(timeStamp)}</timeStamp>` +
        playerRecord(team1, c.result.team1Td, c.result.team1Cas) +
        playerRecord(team2, c.result.team2Td, c.result.team2Cas) +
        `</game>`
      );
    })
    .filter((g): g is string => g !== null)
    .join('\n');

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<nafReport xmlns:blo="http://www.bloodbowl.net">\n` +
    `<organiser>${escapeXml(tournament.name)}</organiser>\n` +
    `<coaches>\n${coachesXml}\n</coaches>\n` +
    `${gamesXml}\n` +
    `</nafReport>\n`
  );
}
