import { RACE_TO_NAF_TEAM, type Challenge, type Team, type Tournament } from './types';

/**
 * The NAF's own documented stand-in for a non-NAF-registered opponent in an otherwise
 * NAF-sanctioned event: "a generic coach 'non-NAF' with ID #9 (pronounced 'nein')". Used in place
 * of the real coach identity on the non-NAF side of a mixed match, so that match isn't silently
 * dropped just because one participant never registered with the NAF.
 */
const NON_NAF_COACH_NAME = 'non-NAF';
const NON_NAF_COACH_NUMBER = '9';
/** Declared when the non-NAF opponents folded into the generic coach played more than one race. */
const MULTI_RACE_LABEL = 'Multi-race';

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

/** The generic non-NAF coach's declared team: the single real race if every non-NAF opponent
 * folded into it played the same one, otherwise the NAF's "Multi-race" declaration. */
function nonNafTeamLabel(races: Set<Team['race']>): string {
  if (races.size !== 1) return MULTI_RACE_LABEL;
  const [race] = races;
  return RACE_TO_NAF_TEAM[race as keyof typeof RACE_TO_NAF_TEAM] ?? MULTI_RACE_LABEL;
}

/**
 * Builds the `nafReport` XML export described in inspiration/naf-xml-export-spec.md.
 *
 * Unlike the vendored Tourma app this is reimplementing, `touchDowns`/`badlyHurt` are the
 * team's actual TD/casualty totals for the match, not whatever the tournament's first two
 * scoring criteria happen to be (Tourma's behavior, not a NAF requirement).
 *
 * A match between a NAF-registered coach and one who never registered is no longer dropped: the
 * non-NAF side is reported under the NAF's own generic "non-NAF" coach (#9) instead of being
 * silently excluded — see NON_NAF_COACH_NAME. A match between two non-NAF coaches has nothing to
 * report to the NAF either way and is still excluded.
 */
export function buildNafExport(tournament: Tournament): string {
  const eligibleTeams = new Map<string, { label: string }>();
  for (const team of tournament.teams) {
    const label = nafTeamLabel(team);
    if (label) eligibleTeams.set(team.id, { label });
  }

  const completedGames = tournament.challenges.filter(
    (c): c is Challenge & { result: NonNullable<Challenge['result']> } => c.status === 'completed' && c.result !== null
  );

  // Every non-NAF team that ever faces a NAF-registered team in an exported match is folded into
  // the single generic "non-NAF" coach entry — collect their races to decide whether that coach's
  // declared team is one specific race or "Multi-race".
  const nonNafRaces = new Set<Team['race']>();
  for (const c of completedGames) {
    const team1 = tournament.teams.find((t) => t.id === c.team1Id);
    const team2 = tournament.teams.find((t) => t.id === c.team2Id);
    if (!team1 || !team2) continue;
    const eligible1 = eligibleTeams.has(team1.id);
    const eligible2 = eligibleTeams.has(team2.id);
    if (eligible1 === eligible2) continue; // both NAF-registered (normal) or both non-NAF (nothing to report)
    nonNafRaces.add((eligible1 ? team2 : team1).race);
  }
  const usesGenericNonNafCoach = nonNafRaces.size > 0;

  const coachesXml = [
    ...tournament.teams
      .filter((team) => eligibleTeams.has(team.id))
      .map(
        (team) =>
          `<coach><name>${escapeXml(team.coachName)}</name><number>${escapeXml(team.nafNumber!)}</number><team>${escapeXml(
            eligibleTeams.get(team.id)!.label
          )}</team></coach>`
      ),
    ...(usesGenericNonNafCoach
      ? [
          `<coach><name>${escapeXml(NON_NAF_COACH_NAME)}</name><number>${NON_NAF_COACH_NUMBER}</number><team>${escapeXml(
            nonNafTeamLabel(nonNafRaces)
          )}</team></coach>`,
        ]
      : []),
  ].join('\n');

  const gamesXml = completedGames
    .map((c) => {
      const team1 = tournament.teams.find((t) => t.id === c.team1Id);
      const team2 = tournament.teams.find((t) => t.id === c.team2Id);
      if (!team1 || !team2) return null;
      const eligible1 = eligibleTeams.has(team1.id);
      const eligible2 = eligibleTeams.has(team2.id);
      if (!eligible1 && !eligible2) return null; // neither side NAF-registered — nothing to report

      const timeStamp = `${c.result.playedAt} 12:00`;
      const playerRecord = (team: Team, eligible: boolean, td: number, cas: number) =>
        `<playerRecord><name>${escapeXml(eligible ? team.coachName : NON_NAF_COACH_NAME)}</name><number>${escapeXml(
          eligible ? team.nafNumber! : NON_NAF_COACH_NUMBER
        )}</number><teamRating>0</teamRating><touchDowns>${td}</touchDowns><badlyHurt>${cas}</badlyHurt></playerRecord>`;

      return (
        `<game><timeStamp>${escapeXml(timeStamp)}</timeStamp>` +
        playerRecord(team1, eligible1, c.result.team1Td, c.result.team1Cas) +
        playerRecord(team2, eligible2, c.result.team2Td, c.result.team2Cas) +
        `</game>`
      );
    })
    .filter((g): g is string => g !== null)
    .join('\n');

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<nafReport xmlns:blo="http://www.bloodbowl.net">\n` +
    `<organiser>${escapeXml(tournament.organizerCoachName || tournament.name)}</organiser>\n` +
    `<coaches>\n${coachesXml}\n</coaches>\n` +
    `${gamesXml}\n` +
    `</nafReport>\n`
  );
}
