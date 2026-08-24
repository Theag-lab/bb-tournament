export type ChallengeStatus =
  | 'pending' // waiting for the challenged team to accept/decline
  | 'accepted' // match agreed, not yet played
  | 'declined'
  | 'cancelled'
  | 'awaiting_confirmation' // one side submitted a result, waiting for the other to confirm
  | 'completed';

export interface MatchResult {
  playedAt: string; // date the match was actually played, YYYY-MM-DD, entered by whoever fills the sheet
  team1Td: number;
  team2Td: number;
  team1Cas: number;
  team2Cas: number;
  team1Agg: number; // aggressions (blocks that could have caused a casualty) committed by team 1
  team2Agg: number;
  concededByTeamId: string | null;
  team1Points: number;
  team2Points: number;
  submittedByTeamId: string;
  submittedAt: string;
  confirmedByTeamId: string | null;
  completedAt: string | null;
  finalizedByAdmin?: boolean;
}

export interface Challenge {
  id: string;
  team1Id: string; // challenger
  team2Id: string; // challenged
  status: ChallengeStatus;
  round: number | null; // null = free challenge (ladder, or pre-round-1 in swiss_with_challenge)
  createdAt: string;
  updatedAt: string;
  result: MatchResult | null;
}

export interface RosterImage {
  updatedAt: string;
}

// Only meaningful when the tournament's requireRosterValidation is true; otherwise ignored.
export type RosterStatus = 'created' | 'submitted' | 'validated';

export type TournamentMode = 'ladder' | 'swiss' | 'swiss_with_challenge' | 'pools_knockout';

export type RoundStatus = 'draft' | 'launched'; // draft = admin-only, pairings can still be swapped

export interface RoundInfo {
  number: number;
  status: RoundStatus;
}

/**
 * A single admin-controlled countdown, meant for a "current round" clock on the projector/kiosk
 * page — not tied to a specific round number, since only one round is ever being actively played
 * at a time; the admin restarts it (via `start`) each time a new round begins.
 */
export interface RoundTimerState {
  durationSeconds: number;
  startedAt: string | null; // ISO timestamp of the last (re)start; null = not running
}

export const MIN_ROUND_TIMER_SECONDS = 60; // 1 minute
export const MAX_ROUND_TIMER_SECONDS = 6 * 60 * 60; // 6 hours
export const DEFAULT_ROUND_TIMER_SECONDS = 2.5 * 60 * 60; // 2h30, a common round length
export const DEFAULT_ROUND_TIMER: RoundTimerState = {
  durationSeconds: DEFAULT_ROUND_TIMER_SECONDS,
  startedAt: null,
};

export const MIN_ROUND_COUNT = 1;
export const MAX_ROUND_COUNT = 20;

/**
 * 'individual' (default): each Team is ranked on its own, as today. 'team': Teams are grouped
 * into Squads (see below) — squad standings drive round pairing (double-swiss), individual
 * standings are still computed and shown alongside. A 'team' tournament always forces
 * `mode: 'swiss'` server-side (no free challenges) — see backend/src/handlers/tournaments.ts.
 */
export type TournamentFormat = 'individual' | 'team';

export interface Squad {
  id: string;
  name: string;
  createdAt: string;
}

export const MIN_SQUAD_SIZE = 2;
export const MAX_SQUAD_SIZE = 20;

export const MIN_POOL_SIZE = 3;
export const MAX_POOL_SIZE = 20;
export const MIN_QUALIFIERS_PER_POOL = 1;
export const MAX_QUALIFIERS_PER_POOL = MAX_POOL_SIZE - 1;

export interface Pool {
  id: string;
  name: string;
  createdAt: string;
}

/**
 * Squad-level round scoring, independent from the individual W/D/L points (see
 * IndividualScoringConfig in this file). A squad plays exactly one
 * opposing squad per round (its members' matches are that round's "boards", like a chess team
 * match); the round's outcome is bucketed into one of 6 tiers by the squad's net board
 * differential (boards won minus boards lost that round — NOT the TD-difference of any single
 * match) exactly as specified by the tournament organiser: victoire totale / victoire / petite
 * victoire / nul / petite défaite / défaite — asymmetric by design (3 win tiers, only 2 loss
 * tiers; a crushing win is called out specially but any non-small loss is just "défaite", no
 * separate "big loss" tier). E.g. winning 5 boards to 0 (diff +5) is "victoire totale" while
 * winning 3-2 (diff +1) is only "petite victoire" — both used to count as the same plain "win"
 * before this became board-diff-based.
 */
export interface SquadScoringConfig {
  smallMarginMaxDiff: number; // board-diff in [1, this] => "petite" tier (win or loss side)
  bigMarginMinDiff: number; // board-diff >= this => "victoire totale" (win side only)
  pointsBigWin: number;
  pointsWin: number;
  pointsSmallWin: number;
  pointsDraw: number;
  pointsSmallLoss: number;
  pointsLoss: number;
}

export const DEFAULT_SQUAD_SCORING: SquadScoringConfig = {
  smallMarginMaxDiff: 1,
  bigMarginMinDiff: 3,
  pointsBigWin: 5,
  pointsWin: 4,
  pointsSmallWin: 3,
  pointsDraw: 2,
  pointsSmallLoss: 1,
  pointsLoss: 0,
};

/**
 * Individual-standings tiebreaker criteria, only used when `IndividualScoringConfig.mode ===
 * 'points_tiebreaker'`. Applied in the order given by `IndividualScoringConfig.tiebreakers`,
 * each one breaking ties left by the criteria before it.
 */
export type TiebreakerCriterion =
  | 'head_to_head'
  | 'fewest_td_conceded'
  | 'most_td_scored'
  | 'opponent_score'
  | 'net_td'
  | 'net_cas'
  | 'net_agg'
  | 'random';

export const ALL_TIEBREAKER_CRITERIA: TiebreakerCriterion[] = [
  'head_to_head',
  'fewest_td_conceded',
  'most_td_scored',
  'opponent_score',
  'net_td',
  'net_cas',
  'net_agg',
  'random',
];

export type IndividualScoringMode = 'points_tiebreaker' | 'raw_points';

/** 'total' = the team's own stat count for the match, 'diff' = that stat's net difference vs the opponent. */
export type RawPointsStatBasis = 'total' | 'diff';

export interface RawPointsComponent {
  basis: RawPointsStatBasis;
  multiplier: number; // points awarded per unit of the chosen stat; 0 disables this component
}

/**
 * Individual-standings scoring config, configurable per tournament. Applies to every tournament
 * regardless of `format` — 'team' format tournaments still compute individual standings alongside
 * squad standings (see SquadScoringConfig for the separate squad-level scoring).
 *
 * - 'points_tiebreaker' (classic): `pointsWin`/`pointsDraw`/`pointsLoss` decide ranking, ties are
 *   broken by `tiebreakers` in order.
 * - 'raw_points': ranking is purely the additive total of pointsWin/pointsDraw plus the TD/CAS/Agg
 *   components (e.g. 400 pts for a win + 3 pts per TD). `tiebreakers` is ignored.
 */
export interface IndividualScoringConfig {
  mode: IndividualScoringMode;
  pointsWin: number;
  pointsDraw: number;
  pointsLoss: number;
  /** Applied to the conceding team instead of pointsLoss (typically negative — a penalty). */
  pointsConcessionPenalty: number;
  tiebreakers: TiebreakerCriterion[];
  td: RawPointsComponent;
  cas: RawPointsComponent;
  agg: RawPointsComponent;
}

export const MIN_SCORING_POINTS = -1000;
export const MAX_SCORING_POINTS = 1000;
export const MIN_SCORING_MULTIPLIER = -100;
export const MAX_SCORING_MULTIPLIER = 100;

export interface Team {
  id: string;
  password: string;
  name: string;
  coachName: string;
  race: string;
  nafNumber: string | null; // coach's NAF membership number, needed for the NAF XML export
  squadId: string | null; // set when the tournament's format is 'team', otherwise always null
  poolId: string | null; // set when the tournament's mode is 'pools_knockout', otherwise always null
  createdAt: string;
  rosterImage: RosterImage | null;
  rosterStatus: RosterStatus;
}

export interface Tournament {
  id: string;
  name: string;
  description: string; // markdown source, editable by the admin
  // Coach name of the person organizing the tournament — required at creation. Doubles as an
  // accountability record (who's creating tournaments on the site) and populates the NAF export's
  // mandatory <organiser> field (previously mis-populated with the tournament name).
  organizerCoachName: string;
  requireRosterValidation: boolean; // when true, coaches submit rosters for admin approval
  // Public scoreboard display toggle — off hides team names in favour of coach name (and race,
  // where a stat table already has a race column), useful when team name is just a duplicate of
  // the coach name (e.g. after a bulk CSV import). Admin-only management screens are unaffected.
  showTeamNames: boolean;
  mode: TournamentMode;
  roundCount: number | null; // null for ladder mode and pools_knockout mode, required otherwise
  rounds: RoundInfo[];
  format: TournamentFormat;
  squadSize: number | null; // required when format === 'team', otherwise null
  squadScoring: SquadScoringConfig | null; // set when format === 'team', otherwise null
  squads: Squad[];
  // Set when mode === 'pools_knockout', otherwise null. A pool-phase round is any round number
  // <= poolRoundCount; rounds after that are the knockout phase — this is derived, not stored per
  // round (see RoundInfo).
  poolSize: number | null; // target pool size used to auto-generate pools
  poolRoundCount: number | null; // number of swiss rounds played within each pool
  qualifiersPerPool: number | null; // top N per pool advance to the knockout bracket
  pools: Pool[];
  // Ordered qualifier list (bracket seed order) — set once, when the admin launches the knockout
  // phase; null while still in the pool phase. Its mere presence is the "phase transitioned" flag.
  knockoutSeeds: string[] | null;
  individualScoring: IndividualScoringConfig;
  roundTimer: RoundTimerState;
  adminToken: string;
  createdAt: string;
  teams: Team[];
  challenges: Challenge[];
}

export const TOURNAMENT_DESCRIPTION_MAX_LENGTH = 20000;
export const ORGANIZER_COACH_NAME_MAX_LENGTH = 80;

// ---- Public (sanitized) shapes returned to non-owners ----

export interface PublicTeam {
  id: string;
  name: string;
  coachName: string;
  race: string;
  nafNumber: string | null;
  squadId: string | null;
  poolId: string | null;
  createdAt: string;
  rosterImage: RosterImage | null;
  rosterStatus: RosterStatus;
}

export interface PublicChallenge {
  id: string;
  team1Id: string;
  team2Id: string;
  status: ChallengeStatus;
  round: number | null;
  createdAt: string;
  updatedAt: string;
  result: MatchResult | null;
}

export interface StandingEntry {
  teamId: string;
  points: number;
  wins: number;
  draws: number;
  losses: number;
  tdFor: number;
  tdAgainst: number;
  casFor: number;
  casAgainst: number;
  aggFor: number;
  aggAgainst: number;
  gamesPlayed: number;
  /** Sum of opponents' final tournament points (Buchholz-style strength-of-schedule tiebreaker). */
  opponentScore: number;
}

/** Squad-level equivalent of StandingEntry, only populated for 'team' format tournaments. */
export interface SquadStandingEntry {
  squadId: string;
  points: number; // computed via SquadScoringConfig, not the individual W/D/L points
  // W/D/L by TD comparison per match (independent of the 6-tier squad points above, same idea as
  // the individual W/D/L record).
  wins: number;
  draws: number;
  losses: number;
  tdFor: number;
  tdAgainst: number;
  casFor: number;
  casAgainst: number;
  aggFor: number;
  aggAgainst: number;
  gamesPlayed: number;
}

/** Pool-scoped equivalent of StandingEntry, only populated for 'pools_knockout' mode tournaments. */
export interface PoolStandingEntry {
  poolId: string;
  standings: StandingEntry[];
}

/**
 * One elimination-bracket match, always backed by a real Challenge (used for result entry).
 * `position` is a continuous 0-based index within its round, interleaving byes and matches in
 * bracket-advancement order, so the next round's parent slot is always `floor(position / 2)`.
 */
export interface BracketMatchView {
  challengeId: string;
  position: number;
  team1Id: string;
  team2Id: string;
  winnerTeamId: string | null; // null until the match is completed
}

/** A team that auto-advances without playing (bracket size padded to the next power of two). */
export interface BracketByeView {
  position: number;
  teamId: string;
}

export interface BracketRoundView {
  roundNumber: number;
  matches: BracketMatchView[];
  byes: BracketByeView[]; // only ever non-empty on the first knockout round
}

export interface PublicTournament {
  id: string;
  name: string;
  description: string;
  organizerCoachName: string;
  requireRosterValidation: boolean;
  showTeamNames: boolean;
  mode: TournamentMode;
  roundCount: number | null;
  rounds: RoundInfo[]; // launched rounds only
  format: TournamentFormat;
  squadSize: number | null;
  squadScoring: SquadScoringConfig | null;
  squads: Squad[];
  poolSize: number | null;
  poolRoundCount: number | null;
  qualifiersPerPool: number | null;
  pools: Pool[];
  individualScoring: IndividualScoringConfig;
  roundTimer: RoundTimerState;
  createdAt: string;
  teams: PublicTeam[];
  challenges: PublicChallenge[];
  standings: StandingEntry[];
  squadStandings: SquadStandingEntry[];
  poolStandings: PoolStandingEntry[];
  bracket: BracketRoundView[] | null;
  knockoutChampionTeamId: string | null;
}

export interface AdminTeamView extends PublicTeam {
  password: string;
}

export interface AdminTournamentView {
  id: string;
  name: string;
  description: string;
  organizerCoachName: string;
  requireRosterValidation: boolean;
  showTeamNames: boolean;
  mode: TournamentMode;
  roundCount: number | null;
  rounds: RoundInfo[]; // all rounds, including drafts
  format: TournamentFormat;
  squadSize: number | null;
  squadScoring: SquadScoringConfig | null;
  squads: Squad[];
  poolSize: number | null;
  poolRoundCount: number | null;
  qualifiersPerPool: number | null;
  pools: Pool[];
  individualScoring: IndividualScoringConfig;
  roundTimer: RoundTimerState;
  createdAt: string;
  teams: AdminTeamView[];
  challenges: PublicChallenge[];
  standings: StandingEntry[];
  squadStandings: SquadStandingEntry[];
  poolStandings: PoolStandingEntry[];
  bracket: BracketRoundView[] | null;
  knockoutChampionTeamId: string | null;
}

export interface UpdateTournamentDescriptionRequest {
  description: string;
}

export interface UpdateTournamentOrganizerRequest {
  organizerCoachName: string;
}

export interface UpdateDisplaySettingsRequest {
  showTeamNames: boolean;
}

export interface UpdateRoundTimerRequest {
  durationSeconds?: number; // updates the configured duration; doesn't affect an already-running timer's start time
  start?: boolean; // (re)starts the timer now, using durationSeconds if also provided, else the current one
  reset?: boolean; // stops/clears the timer (startedAt -> null); mutually exclusive with `start`
}

export interface CreateTournamentRequest {
  name: string;
  organizerCoachName: string; // required — the organizing coach's name (also used in the NAF export)
  id?: string; // admin-chosen tournament id (becomes the public URL); random UUID if omitted
  requireRosterValidation?: boolean;
  mode?: TournamentMode;
  roundCount?: number; // required when mode !== 'ladder' and mode !== 'pools_knockout'
  format?: TournamentFormat;
  squadSize?: number; // required when format === 'team'
  squadScoring?: Partial<SquadScoringConfig>; // overrides on top of DEFAULT_SQUAD_SCORING
  poolSize?: number; // required when mode === 'pools_knockout'
  poolRoundCount?: number; // required when mode === 'pools_knockout'
  qualifiersPerPool?: number; // required when mode === 'pools_knockout'
  individualScoring?: Partial<IndividualScoringConfig>; // overrides on top of DEFAULT_INDIVIDUAL_SCORING
}

export type UpdateIndividualScoringRequest = Partial<IndividualScoringConfig>;

/**
 * Deliberately narrow charset (lowercase letters, digits, single hyphens between segments) so the
 * id never needs URL-encoding and reads cleanly in a shared link — no uppercase-vs-lowercase
 * ambiguity, no spaces, no unicode.
 */
export const TOURNAMENT_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const TOURNAMENT_ID_MIN_LENGTH = 3;
export const TOURNAMENT_ID_MAX_LENGTH = 50;

export interface UpdateRosterStatusRequest {
  status: RosterStatus;
}

export interface SwapRoundMatchesRequest {
  matchId1: string;
  matchId2: string;
}

export interface CreateTournamentResponse {
  tournamentId: string;
  adminToken: string;
}

export interface CreateTeamRequest {
  // Required for 'individual' tournaments; ignored/auto-generated for 'team' format, where the
  // squad name is the meaningful identity and the coach never enters their own team name.
  name?: string;
  coachName: string;
  race: string;
  password: string;
  nafNumber?: string | null; // optional; coaches can also set/change it later from their team page
  // Exactly one of these two is required when the tournament's format is 'team'; ignored otherwise.
  squadId?: string; // join an existing squad
  newSquadName?: string; // create a new squad and join it
}

export interface CreateSquadRequest {
  name: string;
}

export interface UpdateSquadRequest {
  name: string;
}

export interface AssignTeamSquadRequest {
  squadId: string | null;
}

export type UpdateSquadScoringRequest = Partial<SquadScoringConfig>;

export interface AssignTeamPoolRequest {
  poolId: string | null;
}

export interface UpdatePoolRequest {
  name: string;
}

export const TEAM_PASSWORD_MIN_LENGTH = 4;
export const TEAM_PASSWORD_MAX_LENGTH = 32;

/** NAF membership numbers are plain positive integers, printed on naf.net coach profiles. */
export const NAF_NUMBER_PATTERN = /^[1-9][0-9]{0,6}$/;

export interface CreateTeamResponse {
  teamId: string;
}

/**
 * One parsed CSV row for the admin bulk-import feature (fixed column order: coach name, race,
 * NAF number — no header row). `race` is free text as pasted; the server re-resolves it against
 * `RACES` via `matchRace` (see textMatch.ts) rather than trusting it verbatim, even though the
 * admin UI already resolves/lets the admin fix it client-side before submitting.
 */
export interface ImportTeamRow {
  coachName: string;
  race: string;
  nafNumber?: string;
}

export interface ImportTeamsRequest {
  rows: ImportTeamRow[];
}

export interface ImportTeamsResponse {
  teamIds: string[];
}

export const MAX_TEAM_IMPORT_ROWS = 200;

export interface ResolveTeamResponse {
  teamId: string;
  name: string;
  coachName: string;
  race: string;
}

export interface RosterImageUploadUrlRequest {
  contentType: string;
}

export interface RosterImageUploadUrlResponse {
  url: string;
  fields: Record<string, string>;
}

export const ROSTER_IMAGE_ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const ROSTER_IMAGE_MAX_SIZE_BYTES = 5 * 1024 * 1024;

export interface CreateChallengeRequest {
  opponentTeamId: string;
}

export type ChallengeAction = 'accept' | 'decline' | 'cancel';

export interface ChallengeActionRequest {
  action: ChallengeAction;
}

export interface SubmitResultRequest {
  playedAt: string;
  team1Td: number;
  team2Td: number;
  team1Cas: number;
  team2Cas: number;
  team1Agg: number;
  team2Agg: number;
  concededByTeamId: string | null;
}

export const RACES = [
  'Amazon',
  'Black Orc',
  'Bretonnia',
  'Chaos Chosen',
  'Chaos Dwarf',
  'Chaos Renegade',
  'Dark Elf',
  'Dwarf',
  'Elven Union',
  'Gnomes',
  'Goblins',
  'Halflings',
  'High Elf',
  'Human',
  'Imperial Nobility',
  'Khorne',
  'Lizardmen',
  'Necromantic Horror',
  'Norse',
  'Nurgle',
  'Ogres',
  'Old World Alliance',
  'Orc',
  'Shambling Undead',
  'Skaven',
  'Slann',
  'Snotlings',
  'Tomb Kings',
  'Underworld Denizens',
  'Vampire',
  'Wood Elf',
] as const;

/**
 * This app's `RACES` don't line up 1:1 with the NAF's own team-name labels (see
 * inspiration/naf-xml-export-spec.md). `null` means there's no confirmed NAF equivalent, so
 * teams of that race are silently left out of the NAF export, same as picking "None" in Tourma.
 *
 * Verified against Tourma's own roster-translation table (`RosterType.java` /
 * `rosters.properties`), not just its stale XSD: `Snotlings` and `Old World Alliance` ARE
 * recognized NAF team names there (Tourma's own properties file misspells the latter as "Old
 * Wolrd Alliance" when exporting — a Tourma typo, not reproduced here). `Gnomes` and `Imperial
 * Nobility` have no trace anywhere in Tourma — confirmed a known Tourma gap (it predates these
 * BB2020 rosters), not evidence NAF lacks them. Mapped to their GW/BB2020 names as-is, since
 * recently-added rosters don't carry the legacy NAF/GW naming mismatches older teams have
 * (e.g. `Chaos`/`Chaos Chosen`, `Bretonnians`/`Bretonnia`).
 */
export const RACE_TO_NAF_TEAM: Record<(typeof RACES)[number], string | null> = {
  Amazon: 'Amazon',
  'Black Orc': 'Black Orc',
  Bretonnia: 'Bretonnian',
  'Chaos Chosen': 'Chaos Chosen',
  'Chaos Dwarf': 'Chaos Dwarves',
  'Chaos Renegade': 'Chaos Renegade',
  'Dark Elf': 'Dark Elf',
  Dwarf: 'Dwarf',
  'Elven Union': 'Elf Union',
  Gnomes: 'Gnome',
  Goblins: 'Goblin',
  Halflings: 'Halfling',
  'High Elf': 'High Elf',
  Human: 'Human',
  'Imperial Nobility': 'Imperial Nobility',
  Khorne: 'Khorne',
  Lizardmen: 'Lizardmen',
  'Necromantic Horror': 'Necromantic Horror',
  Norse: 'Norse',
  Nurgle: "Nurgle",
  Ogres: 'Ogre',
  'Old World Alliance': 'Old World Alliance',
  Orc: 'Orc',
  'Shambling Undead': 'Shambling Undead',
  Skaven: 'Skaven',
  Slann: 'Slann',
  Snotlings: 'Snotling',
  'Tomb Kings': 'Tomb Kings',
  'Underworld Denizens': 'Underworld Denizens',
  Vampire: 'Vampire',
  'Wood Elf': 'Wood Elf',
};
