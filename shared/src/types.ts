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

export type TournamentMode = 'ladder' | 'swiss' | 'swiss_with_challenge';

export type RoundStatus = 'draft' | 'launched'; // draft = admin-only, pairings can still be swapped

export interface RoundInfo {
  number: number;
  status: RoundStatus;
}

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

/**
 * Squad-level match scoring, independent from the individual W/D/L points (POINTS_WIN etc. in
 * scoring.ts). Buckets a match's TD-difference into one of 6 tiers exactly as specified by the
 * tournament organiser: victoire totale / victoire / petite victoire / nul / petite défaite /
 * défaite — asymmetric by design (3 win tiers, only 2 loss tiers; a crushing win is called out
 * specially but any non-small loss is just "défaite", no separate "big loss" tier).
 */
export interface SquadScoringConfig {
  smallMarginMaxDiff: number; // TD-difference in [1, this] => "petite" tier (win or loss side)
  bigMarginMinDiff: number; // TD-difference >= this => "victoire totale" (win side only)
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

export interface Team {
  id: string;
  password: string;
  name: string;
  coachName: string;
  race: string;
  nafNumber: string | null; // coach's NAF membership number, needed for the NAF XML export
  squadId: string | null; // set when the tournament's format is 'team', otherwise always null
  createdAt: string;
  rosterImage: RosterImage | null;
  rosterStatus: RosterStatus;
}

export interface Tournament {
  id: string;
  name: string;
  description: string; // markdown source, editable by the admin
  requireRosterValidation: boolean; // when true, coaches submit rosters for admin approval
  mode: TournamentMode;
  roundCount: number | null; // null for ladder mode, required otherwise
  rounds: RoundInfo[];
  format: TournamentFormat;
  squadSize: number | null; // required when format === 'team', otherwise null
  squadScoring: SquadScoringConfig | null; // set when format === 'team', otherwise null
  squads: Squad[];
  adminToken: string;
  createdAt: string;
  teams: Team[];
  challenges: Challenge[];
}

export const TOURNAMENT_DESCRIPTION_MAX_LENGTH = 20000;

// ---- Public (sanitized) shapes returned to non-owners ----

export interface PublicTeam {
  id: string;
  name: string;
  coachName: string;
  race: string;
  nafNumber: string | null;
  squadId: string | null;
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
  tdFor: number;
  tdAgainst: number;
  casFor: number;
  casAgainst: number;
  aggFor: number;
  aggAgainst: number;
  gamesPlayed: number;
}

export interface PublicTournament {
  id: string;
  name: string;
  description: string;
  requireRosterValidation: boolean;
  mode: TournamentMode;
  roundCount: number | null;
  rounds: RoundInfo[]; // launched rounds only
  format: TournamentFormat;
  squadSize: number | null;
  squadScoring: SquadScoringConfig | null;
  squads: Squad[];
  createdAt: string;
  teams: PublicTeam[];
  challenges: PublicChallenge[];
  standings: StandingEntry[];
  squadStandings: SquadStandingEntry[];
}

export interface AdminTeamView extends PublicTeam {
  password: string;
}

export interface AdminTournamentView {
  id: string;
  name: string;
  description: string;
  requireRosterValidation: boolean;
  mode: TournamentMode;
  roundCount: number | null;
  rounds: RoundInfo[]; // all rounds, including drafts
  format: TournamentFormat;
  squadSize: number | null;
  squadScoring: SquadScoringConfig | null;
  squads: Squad[];
  createdAt: string;
  teams: AdminTeamView[];
  challenges: PublicChallenge[];
  standings: StandingEntry[];
  squadStandings: SquadStandingEntry[];
}

export interface UpdateTournamentDescriptionRequest {
  description: string;
}

export interface CreateTournamentRequest {
  name: string;
  requireRosterValidation?: boolean;
  mode?: TournamentMode;
  roundCount?: number; // required when mode !== 'ladder'
  format?: TournamentFormat;
  squadSize?: number; // required when format === 'team'
  squadScoring?: Partial<SquadScoringConfig>; // overrides on top of DEFAULT_SQUAD_SCORING
}

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
  name: string;
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

export const TEAM_PASSWORD_MIN_LENGTH = 4;
export const TEAM_PASSWORD_MAX_LENGTH = 32;

/** NAF membership numbers are plain positive integers, printed on naf.net coach profiles. */
export const NAF_NUMBER_PATTERN = /^[1-9][0-9]{0,6}$/;

export interface CreateTeamResponse {
  teamId: string;
}

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
