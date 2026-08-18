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
  createdAt: string;
  updatedAt: string;
  result: MatchResult | null;
}

export interface RosterImage {
  updatedAt: string;
}

export interface Team {
  id: string;
  password: string;
  name: string;
  coachName: string;
  race: string;
  createdAt: string;
  rosterImage: RosterImage | null;
}

export interface Tournament {
  id: string;
  name: string;
  description: string; // markdown source, editable by the admin
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
  createdAt: string;
  rosterImage: RosterImage | null;
}

export interface PublicChallenge {
  id: string;
  team1Id: string;
  team2Id: string;
  status: ChallengeStatus;
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
  gamesPlayed: number;
}

export interface PublicTournament {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  teams: PublicTeam[];
  challenges: PublicChallenge[];
  standings: StandingEntry[];
}

export interface AdminTeamView extends PublicTeam {
  password: string;
}

export interface AdminTournamentView {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  teams: AdminTeamView[];
  challenges: PublicChallenge[];
  standings: StandingEntry[];
}

export interface UpdateTournamentDescriptionRequest {
  description: string;
}

export interface CreateTournamentRequest {
  name: string;
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
}

export const TEAM_PASSWORD_MIN_LENGTH = 4;
export const TEAM_PASSWORD_MAX_LENGTH = 32;

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
