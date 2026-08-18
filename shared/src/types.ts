export type ChallengeStatus =
  | 'pending' // waiting for the challenged team to accept/decline
  | 'accepted' // match agreed, not yet played
  | 'declined'
  | 'cancelled'
  | 'awaiting_confirmation' // one side submitted a result, waiting for the other to confirm
  | 'completed';

export interface MatchResult {
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

export interface Team {
  id: string;
  participantToken: string;
  name: string;
  coachName: string;
  race: string;
  createdAt: string;
}

export interface Tournament {
  id: string;
  name: string;
  adminToken: string;
  createdAt: string;
  teams: Team[];
  challenges: Challenge[];
}

// ---- Public (sanitized) shapes returned to non-owners ----

export interface PublicTeam {
  id: string;
  name: string;
  coachName: string;
  race: string;
  createdAt: string;
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
  createdAt: string;
  teams: PublicTeam[];
  challenges: PublicChallenge[];
  standings: StandingEntry[];
}

export interface AdminTeamView extends PublicTeam {
  participantToken: string;
}

export interface AdminTournamentView {
  id: string;
  name: string;
  createdAt: string;
  teams: AdminTeamView[];
  challenges: PublicChallenge[];
  standings: StandingEntry[];
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
}

export interface CreateTeamResponse {
  teamId: string;
  participantToken: string;
}

export interface CreateChallengeRequest {
  opponentTeamId: string;
}

export type ChallengeAction = 'accept' | 'decline' | 'cancel';

export interface ChallengeActionRequest {
  action: ChallengeAction;
}

export interface SubmitResultRequest {
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
