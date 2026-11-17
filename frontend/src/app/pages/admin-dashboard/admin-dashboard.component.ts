import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  ALL_SQUAD_TIEBREAKER_CRITERIA,
  ALL_TIEBREAKER_CRITERIA,
  CUSTOM_STAT_NAME_MAX_LENGTH,
  CUSTOM_STAT_PRECISION_MAX_LENGTH,
  DEFAULT_ROSTER_TIERS,
  FRENCH_RACE_LABELS,
  MAX_ROSTER_TIERS,
  RACES,
  MAX_CUSTOM_STAT_CATEGORIES,
  MAX_SCORING_MULTIPLIER,
  MIN_SCORING_MULTIPLIER,
  ORGANIZER_COACH_NAME_MAX_LENGTH,
  TOURNAMENT_DESCRIPTION_MAX_LENGTH,
  customTiebreakerCategoryId,
  customTiebreakerCriterion,
  activeCoaches,
  activeSquadMembers,
  resolveRosterTiers,
  type AdminTeamView,
  type AdminTournamentView,
  type CustomStatCategoryConfig,
  type CustomStatCategoryInput,
  type IndividualScoringConfig,
  type MatchSheetConfig,
  type Pool,
  type PublicTournament,
  type Replacement,
  type RosterTier,
  type RoundInfo,
  type Squad,
  type SquadScoringConfig,
  squadOutcomeKey,
  type SquadTiebreakerCriterion,
  type StandingEntry,
  type SubmitResultRequest,
  type TiebreakerCriterion,
  type TournamentBackupSummary,
  roundSquadOpponents,
  triangleThirdSquad,
} from '@bb-tournament/shared';
import { CurrentTournamentService } from '../../core/current-tournament.service';
import { ApiService } from '../../core/api.service';
import { type BackupIdInfo, parseBackupId } from '../../core/backup';
import { extractErrorMessage } from '../../core/http-error';
import { copyToClipboard, kioskUrl, participantUrl, rosterImageUrl, scoreboardUrl } from '../../core/links';
import { renderMarkdown } from '../../core/markdown';
import { rosterStatusLabel } from '../../core/roster-status';
import { MatchResultFormComponent } from '../../shared/match-result-form/match-result-form.component';
import { BracketGraphComponent } from '../../shared/bracket-graph/bracket-graph.component';
import { TeamImportComponent } from './team-import/team-import.component';
import { FumbblLinkComponent } from '../../shared/fumbbl-link/fumbbl-link.component';

const POLL_INTERVAL_MS = 60000;

type AdminTab =
  | 'overview'
  | 'rounds'
  | 'teams'
  | 'squads'
  | 'pools'
  | 'bracket'
  | 'challenges'
  | 'matchSheet'
  | 'tiering'
  | 'backups';

function cloneIndividualScoring(config: IndividualScoringConfig): IndividualScoringConfig {
  return {
    ...config,
    tiebreakers: [...config.tiebreakers],
    td: { ...config.td },
    cas: { ...config.cas },
    agg: { ...config.agg },
  };
}

export const TIEBREAKER_LABELS: Record<Exclude<TiebreakerCriterion, `custom:${string}`>, string> = {
  head_to_head: 'Confrontation directe',
  fewest_td_conceded: 'TD encaissés (moins = mieux)',
  most_td_scored: 'TD marqués (plus = mieux)',
  opponent_score: "Points adverses (Buchholz)",
  net_td: 'Différentiel de TD',
  net_cas: 'Différentiel de sorties',
  net_agg: "Différentiel d'agressions",
  most_cas_caused: 'Sorties causées (plus = mieux)',
  roster_tier: 'Tier du roster (plus élevé = mieux)',
  random: 'Au pif (stable)',
};

export const SQUAD_TIEBREAKER_LABELS: Record<SquadTiebreakerCriterion, string> = {
  head_to_head: 'Confrontation directe',
  opponent_score: 'Points adverses (Buchholz)',
  fewest_individual_losses: 'Moins de défaites individuelles',
  member_points: 'Somme des points des coachs',
  net_td: 'Différentiel de TD',
  net_cas: 'Différentiel de sorties',
  net_agg: "Différentiel d'agressions",
  most_td_scored: 'TD marqués (plus = mieux)',
  fewest_td_conceded: 'TD encaissés (moins = mieux)',
  most_cas_caused: 'Sorties causées (plus = mieux)',
  roster_tier: 'Somme des tiers des rosters (plus élevé = mieux)',
  random: 'Au pif (stable)',
};

function cloneSquadScoring(config: SquadScoringConfig): SquadScoringConfig {
  return {
    ...config,
    bigWinOutcomes: [...config.bigWinOutcomes],
    smallLossOutcomes: [...config.smallLossOutcomes],
    tiebreakers: [...(config.tiebreakers ?? [])],
  };
}

export interface SquadOutcome {
  key: string; // "W-D-L", as stored in SquadScoringConfig
  wins: number;
  draws: number;
  losses: number;
}

export interface SquadOutcomeLists {
  wins: SquadOutcome[];
  draws: SquadOutcome[];
  losses: SquadOutcome[];
}

/**
 * Every board record a full squad can get in a round. Wins are listed fewest losses first, then
 * most wins (5-0-0, 4-1-0, 3-2-0 … 4-0-1 …); losses closest first (2-0-3, 1-2-2, 0-4-1 … 0-0-5).
 */
function squadOutcomesFor(size: number): SquadOutcomeLists {
  const lists: SquadOutcomeLists = { wins: [], draws: [], losses: [] };
  for (let wins = size; wins >= 0; wins--) {
    for (let losses = 0; wins + losses <= size; losses++) {
      const draws = size - wins - losses;
      const outcome = { key: squadOutcomeKey(wins, draws, losses), wins, draws, losses };
      (wins > losses ? lists.wins : wins < losses ? lists.losses : lists.draws).push(outcome);
    }
  }
  lists.wins.sort((a, b) => a.losses - b.losses || b.wins - a.wins);
  lists.losses.sort((a, b) => a.losses - a.wins - (b.losses - b.wins) || b.wins - a.wins);
  return lists;
}

function cloneMatchSheetConfig(config: MatchSheetConfig): MatchSheetConfig {
  return { td: { ...config.td }, cas: { ...config.cas }, agg: { ...config.agg } };
}

function cloneCustomStatCategories(categories: CustomStatCategoryConfig[]): CustomStatCategoryConfig[] {
  return categories.map((c) => ({ ...c, rawPoints: { ...c.rawPoints } }));
}

interface DerivedLookups {
  tournament: AdminTournamentView | null;
  teamsById: Map<string, AdminTeamView>;
  squadsById: Map<string, Squad>;
  poolsById: Map<string, Pool>;
  teamsWithChallenges: Set<string>;
  squadMemberCounts: Map<string, number>;
  poolMemberCounts: Map<string, number>;
}

export interface RoundMatchRow {
  challenge: PublicTournament['challenges'][number];
  groupStart: boolean;
  groupIndex: number;
  /**
   * First row of each group: "Table N : Squad A vs Squad B" (team format) or the pool name (pool
   * rounds). Rendered as a red divider.
   */
  groupLabel?: string;
  /** Individual format (incl. pool rounds): the match's table number, 1-based across the round. */
  tableNumber?: number;
  leftTeamId: string;
  rightTeamId: string;
  leftTd: number | null;
  rightTd: number | null;
  leftCas: number | null;
  rightCas: number | null;
}

@Component({
  selector: 'app-admin-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, MatchResultFormComponent, BracketGraphComponent, TeamImportComponent, FumbblLinkComponent],
  templateUrl: './admin-dashboard.component.html',
  styleUrl: './admin-dashboard.component.scss',
})
export class AdminDashboardComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ApiService);
  private readonly currentTournament = inject(CurrentTournamentService);
  private pollHandle: ReturnType<typeof setInterval> | null = null;

  tournamentId = '';
  token = '';

  /** Set once ngOnInit parses the route — non-null means "this id is a backup, not a live tournament". */
  backupInfo: BackupIdInfo | null = null;

  /** True only right after navigating here from the tournament-creation screen (see home.component.ts's goToAdmin). */
  showBookmarkReminder = false;

  get isBackupView(): boolean {
    return this.backupInfo !== null;
  }

  tournament: AdminTournamentView | null = null;
  loading = true;
  loadError: string | null = null;

  actionError: string | null = null;
  actionBusy = false;

  copiedTeamId: string | null = null;
  scoreboardCopied = false;
  kioskCopied = false;

  private visiblePasswordTeamIds = new Set<string>();

  isPasswordVisible(teamId: string): boolean {
    return this.visiblePasswordTeamIds.has(teamId);
  }

  togglePasswordVisibility(teamId: string): void {
    if (this.visiblePasswordTeamIds.has(teamId)) this.visiblePasswordTeamIds.delete(teamId);
    else this.visiblePasswordTeamIds.add(teamId);
  }

  roundTimerDurationMinutesDraft = 0;
  savingRoundTimer = false;
  roundTimerError: string | null = null;

  editingResultChallengeId: string | null = null;

  readonly rosterStatusLabel = rosterStatusLabel;

  readonly descriptionMaxLength = TOURNAMENT_DESCRIPTION_MAX_LENGTH;
  descriptionDraft = '';
  descriptionPreview = false;
  savingDescription = false;
  descriptionError: string | null = null;

  readonly organizerCoachNameMaxLength = ORGANIZER_COACH_NAME_MAX_LENGTH;
  organizerCoachNameDraft = '';
  savingOrganizer = false;
  organizerError: string | null = null;

  activeAdminTab: AdminTab = 'overview';

  backups: TournamentBackupSummary[] = [];
  backupsLoaded = false;
  backupsLoading = false;
  backupsError: string | null = null;
  creatingBackup = false;

  openBackupsTab(): void {
    this.activeAdminTab = 'backups';
    if (!this.backupsLoaded) void this.loadBackups();
  }

  async loadBackups(): Promise<void> {
    this.backupsLoading = true;
    this.backupsError = null;
    try {
      const res = await this.api.listBackups(this.tournamentId, this.token);
      this.backups = res.backups;
      this.backupsLoaded = true;
    } catch (err) {
      this.backupsError = extractErrorMessage(err);
    } finally {
      this.backupsLoading = false;
    }
  }

  async createBackup(): Promise<void> {
    this.creatingBackup = true;
    this.backupsError = null;
    try {
      const backup = await this.api.createBackup(this.tournamentId, this.token);
      this.backups = [backup, ...this.backups];
    } catch (err) {
      this.backupsError = extractErrorMessage(err);
    } finally {
      this.creatingBackup = false;
    }
  }

  private derivedCache: DerivedLookups = {
    tournament: null,
    teamsById: new Map(),
    squadsById: new Map(),
    poolsById: new Map(),
    teamsWithChallenges: new Set(),
    squadMemberCounts: new Map(),
    poolMemberCounts: new Map(),
  };

  /**
   * With 50 teams x 5 rounds, template calls like `.find()`/`.filter()` over the full
   * teams/challenges arrays add up fast once you account for how often Angular re-runs change
   * detection (every poll, every keystroke in the description textarea, etc). This rebuilds O(1)
   * lookups once per tournament reference change instead of scanning arrays on every call.
   */
  private get derived(): DerivedLookups {
    if (this.derivedCache.tournament === this.tournament) return this.derivedCache;
    const teamsById = new Map((this.tournament?.teams ?? []).map((t) => [t.id, t]));
    const squadsById = new Map((this.tournament?.squads ?? []).map((s) => [s.id, s]));
    const poolsById = new Map((this.tournament?.pools ?? []).map((p) => [p.id, p]));
    const teamsWithChallenges = new Set<string>();
    const squadMemberCounts = new Map<string, number>();
    const poolMemberCounts = new Map<string, number>();
    for (const c of this.tournament?.challenges ?? []) {
      if (c.status === 'declined') continue;
      teamsWithChallenges.add(c.team1Id);
      teamsWithChallenges.add(c.team2Id);
    }
    for (const team of this.tournament?.teams ?? []) {
      if (team.squadId) squadMemberCounts.set(team.squadId, (squadMemberCounts.get(team.squadId) ?? 0) + 1);
      if (team.poolId) poolMemberCounts.set(team.poolId, (poolMemberCounts.get(team.poolId) ?? 0) + 1);
    }
    this.derivedCache = {
      tournament: this.tournament,
      teamsById,
      squadsById,
      poolsById,
      teamsWithChallenges,
      squadMemberCounts,
      poolMemberCounts,
    };
    return this.derivedCache;
  }

  trackById(_index: number, item: { id: string }): string {
    return item.id;
  }

  trackByRoundNumber(_index: number, round: RoundInfo): number {
    return round.number;
  }

  trackByRoundMatchRow(_index: number, row: { challenge: { id: string } }): string {
    return row.challenge.id;
  }

  async ngOnInit(): Promise<void> {
    this.tournamentId = this.route.snapshot.paramMap.get('tournamentId')!;
    this.token = this.route.snapshot.paramMap.get('token')!;
    this.backupInfo = parseBackupId(this.tournamentId);
    this.showBookmarkReminder = !!(history.state as { justCreated?: boolean } | null)?.justCreated;
    await this.load();
    this.pollHandle = setInterval(() => this.load(true), POLL_INTERVAL_MS);
  }

  dismissBookmarkReminder(): void {
    this.showBookmarkReminder = false;
  }

  ngOnDestroy(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
  }

  async load(silent = false): Promise<void> {
    if (!silent) this.loading = true;
    try {
      this.tournament = await this.api.getAdminTournament(this.tournamentId, this.token);
      this.currentTournament.set(this.tournamentId, this.tournament.name);
      if (!silent) {
        this.descriptionDraft = this.tournament.description;
        this.organizerCoachNameDraft = this.tournament.organizerCoachName;
        if (this.tournament.squadScoring) this.squadScoringDraft = cloneSquadScoring(this.tournament.squadScoring);
        this.individualScoringDraft = cloneIndividualScoring(this.tournament.individualScoring);
        this.matchSheetDraft = cloneMatchSheetConfig(this.tournament.matchSheetConfig);
        this.customStatCategoriesDraft = cloneCustomStatCategories(this.tournament.customStatCategories);
        this.rosterTiersDraft = resolveRosterTiers(this.tournament.rosterTiers);
        this.roundTimerDurationMinutesDraft = Math.round(this.tournament.roundTimer.durationSeconds / 60);
        this.fumbblEnabledDraft = this.tournament.fumbbl?.enabled ?? false;
        this.fumbblTagDraft = this.tournament.fumbbl?.tag ?? '';
      }
      this.loadError = null;
    } catch (err) {
      this.loadError = extractErrorMessage(err);
    } finally {
      this.loading = false;
    }
  }

  descriptionPreviewHtml(): string {
    return renderMarkdown(this.descriptionDraft);
  }

  async saveDescription(): Promise<void> {
    this.savingDescription = true;
    this.descriptionError = null;
    try {
      const pub = await this.api.updateDescription(this.tournamentId, this.token, this.descriptionDraft);
      this.tournament = { ...this.tournament!, description: pub.description };
    } catch (err) {
      this.descriptionError = extractErrorMessage(err);
    } finally {
      this.savingDescription = false;
    }
  }

  async saveOrganizer(): Promise<void> {
    const name = this.organizerCoachNameDraft.trim();
    if (!name) return;
    this.savingOrganizer = true;
    this.organizerError = null;
    try {
      const pub = await this.api.updateOrganizer(this.tournamentId, this.token, name);
      this.tournament = { ...this.tournament!, organizerCoachName: pub.organizerCoachName };
      this.organizerCoachNameDraft = pub.organizerCoachName;
    } catch (err) {
      this.organizerError = extractErrorMessage(err);
    } finally {
      this.savingOrganizer = false;
    }
  }

  savingDisplaySettings = false;
  displaySettingsError: string | null = null;

  async setShowTeamNames(showTeamNames: boolean): Promise<void> {
    this.savingDisplaySettings = true;
    this.displaySettingsError = null;
    try {
      this.tournament = await this.api.updateDisplaySettings(this.tournamentId, this.token, showTeamNames);
    } catch (err) {
      this.displaySettingsError = extractErrorMessage(err);
    } finally {
      this.savingDisplaySettings = false;
    }
  }

  savingResultValidation = false;
  resultValidationError: string | null = null;

  fumbblEnabledDraft = false;
  fumbblTagDraft = '';
  savingFumbbl = false;
  fumbblError: string | null = null;
  fumbblSaved = false;

  async saveFumbblTracking(): Promise<void> {
    this.savingFumbbl = true;
    this.fumbblError = null;
    this.fumbblSaved = false;
    try {
      this.tournament = await this.api.updateFumbblTracking(this.tournamentId, this.token, {
        enabled: this.fumbblEnabledDraft,
        tag: this.fumbblTagDraft.trim(),
      });
      this.fumbblTagDraft = this.tournament.fumbbl?.tag ?? '';
      this.fumbblSaved = true;
    } catch (err) {
      this.fumbblError = extractErrorMessage(err);
    } finally {
      this.savingFumbbl = false;
    }
  }

  async setRequireResultConfirmation(requireResultConfirmation: boolean): Promise<void> {
    this.savingResultValidation = true;
    this.resultValidationError = null;
    try {
      this.tournament = await this.api.updateResultValidationSettings(
        this.tournamentId,
        this.token,
        requireResultConfirmation
      );
    } catch (err) {
      this.resultValidationError = extractErrorMessage(err);
    } finally {
      this.savingResultValidation = false;
    }
  }

  teamName(teamId: string): string {
    return this.derived.teamsById.get(teamId)?.name ?? '—';
  }

  teamCoach(teamId: string): string {
    return this.derived.teamsById.get(teamId)?.coachName ?? '—';
  }

  /** Match-sheet field label: coach first, like the match header, so each field is unambiguous. */
  resultFormLabel(teamId: string): string {
    return `${this.teamCoach(teamId)} (${this.teamName(teamId)})`;
  }

  teamHasChallenges(teamId: string): boolean {
    return this.derived.teamsWithChallenges.has(teamId);
  }

  freeChallenges(): PublicTournament['challenges'] {
    return this.tournament?.challenges.filter((c) => c.round === null) ?? [];
  }

  teamRosterImageUrl(teamId: string): string | null {
    const team = this.derived.teamsById.get(teamId);
    if (!team?.rosterImage) return null;
    return rosterImageUrl(this.tournamentId, team.id, team.rosterImage.updatedAt);
  }

  lightboxImageUrl: string | null = null;

  openImageLightbox(url: string): void {
    this.lightboxImageUrl = url;
  }

  closeImageLightbox(): void {
    this.lightboxImageUrl = null;
  }

  participantLink(teamId: string, password: string): string {
    return participantUrl(this.tournamentId, teamId, password);
  }

  async copyTeamLink(teamId: string, password: string): Promise<void> {
    const ok = await copyToClipboard(this.participantLink(teamId, password));
    this.copiedTeamId = ok ? teamId : null;
  }

  async copyScoreboardLink(): Promise<void> {
    this.scoreboardCopied = await copyToClipboard(scoreboardUrl(this.tournamentId));
  }

  kioskLinkUrl(): string {
    return kioskUrl(this.tournamentId);
  }

  async copyKioskLink(): Promise<void> {
    this.kioskCopied = await copyToClipboard(this.kioskLinkUrl());
  }

  async saveRoundTimerDuration(): Promise<void> {
    this.savingRoundTimer = true;
    this.roundTimerError = null;
    try {
      const durationSeconds = Math.round(this.roundTimerDurationMinutesDraft * 60);
      this.tournament = await this.api.updateRoundTimer(this.tournamentId, this.token, { durationSeconds });
    } catch (err) {
      this.roundTimerError = extractErrorMessage(err);
    } finally {
      this.savingRoundTimer = false;
    }
  }

  async startRoundTimer(): Promise<void> {
    this.savingRoundTimer = true;
    this.roundTimerError = null;
    try {
      this.tournament = await this.api.updateRoundTimer(this.tournamentId, this.token, { start: true });
    } catch (err) {
      this.roundTimerError = extractErrorMessage(err);
    } finally {
      this.savingRoundTimer = false;
    }
  }

  async resetRoundTimer(): Promise<void> {
    this.savingRoundTimer = true;
    this.roundTimerError = null;
    try {
      this.tournament = await this.api.updateRoundTimer(this.tournamentId, this.token, { reset: true });
    } catch (err) {
      this.roundTimerError = extractErrorMessage(err);
    } finally {
      this.savingRoundTimer = false;
    }
  }

  nafExportUrl(): string {
    return this.api.nafExportUrl(this.tournamentId, this.token);
  }

  matchSheetLogsUrl(): string {
    return this.api.matchSheetLogsUrl(this.tournamentId, this.token);
  }

  showTeamImport = false;

  onTeamsImported(tournament: AdminTournamentView): void {
    this.tournament = tournament;
    this.showTeamImport = false;
  }

  async deleteTeam(teamId: string): Promise<void> {
    this.actionBusy = true;
    this.actionError = null;
    try {
      this.tournament = await this.api.deleteTeam(this.tournamentId, teamId, this.token);
    } catch (err) {
      this.actionError = extractErrorMessage(err);
    } finally {
      this.actionBusy = false;
    }
  }

  async challengeAction(challengeId: string, action: 'accept' | 'decline' | 'cancel'): Promise<void> {
    this.actionBusy = true;
    this.actionError = null;
    try {
      const pub = await this.api.actionChallenge(this.tournamentId, challengeId, { token: this.token }, action);
      this.tournament = { ...this.tournament!, challenges: pub.challenges, standings: pub.standings };
    } catch (err) {
      this.actionError = extractErrorMessage(err);
    } finally {
      this.actionBusy = false;
    }
  }

  toggleResultForm(challengeId: string): void {
    this.editingResultChallengeId = this.editingResultChallengeId === challengeId ? null : challengeId;
  }

  async forceResult(challengeId: string, body: SubmitResultRequest): Promise<void> {
    this.actionBusy = true;
    this.actionError = null;
    try {
      const pub = await this.api.adminSetResult(this.tournamentId, challengeId, this.token, body);
      this.tournament = { ...this.tournament!, challenges: pub.challenges, standings: pub.standings };
      this.editingResultChallengeId = null;
    } catch (err) {
      this.actionError = extractErrorMessage(err);
    } finally {
      this.actionBusy = false;
    }
  }

  private mergePublicTournament(pub: PublicTournament): void {
    if (!this.tournament) return;
    const teams = this.tournament.teams.map((adminTeam) => {
      const updated = pub.teams.find((t) => t.id === adminTeam.id);
      return updated ? { ...adminTeam, ...updated } : adminTeam;
    });
    this.tournament = { ...this.tournament, teams, challenges: pub.challenges, standings: pub.standings };
  }

  async setRosterStatus(teamId: string, status: 'validated' | 'created'): Promise<void> {
    this.actionBusy = true;
    this.actionError = null;
    try {
      const pub = await this.api.updateRosterStatus(this.tournamentId, teamId, { token: this.token }, status);
      this.mergePublicTournament(pub);
    } catch (err) {
      this.actionError = extractErrorMessage(err);
    } finally {
      this.actionBusy = false;
    }
  }

  roundBusy = false;
  roundError: string | null = null;
  swapTeamId1 = '';
  swapTeamId2 = '';
  pairSquadId1 = '';
  pairSquadId2 = '';
  redrawKeepLocks = true;

  /** null = "follow the latest round" (auto-advances as new rounds get generated); a number pins it. */
  private pinnedRoundNumber: number | null = null;

  get displayedRound(): RoundInfo | null {
    if (!this.tournament?.rounds.length) return null;
    if (this.pinnedRoundNumber !== null) {
      const round = this.tournament.rounds.find((r) => r.number === this.pinnedRoundNumber);
      if (round) return round;
    }
    return this.tournament.rounds[this.tournament.rounds.length - 1];
  }

  selectRound(roundNumber: number): void {
    this.pinnedRoundNumber = roundNumber;
  }

  roundMatches(roundNumber: number): PublicTournament['challenges'] {
    return this.tournament?.challenges.filter((c) => c.round === roundNumber) ?? [];
  }

  /**
   * Every coach in the round, each labeled with their current opponent, for the swap-opponent
   * pickers. Team format also lists coaches on a bye (uneven squads), and labels each with their squad.
   */
  roundCoaches(roundNumber: number): { teamId: string; label: string }[] {
    const opponents = new Map<string, string>();
    for (const c of this.roundMatches(roundNumber)) {
      opponents.set(c.team1Id, c.team2Id);
      opponents.set(c.team2Id, c.team1Id);
    }
    // Team format: every coach playing this round (replacements applied), on a bye or not.
    const teamIds = this.isTeamFormat
      ? (this.tournament?.squads ?? []).flatMap((sq) => [...this.playingInRound(sq.id, roundNumber)])
      : Array.from(opponents.keys());
    return teamIds.map((teamId) => {
      const opponentId = opponents.get(teamId);
      const versus = opponentId ? `vs ${this.teamCoach(opponentId)}` : 'exempt';
      const squad = this.isTeamFormat ? ` — ${this.squadName(this.teamSquadId(teamId))}` : '';
      return { teamId, label: `${this.teamCoach(teamId)}${squad} (${versus})` };
    });
  }

  /** Squads facing `squadId` in this round (normally exactly one). */
  private roundOpponentSquads(roundNumber: number, squadId: string | null): Set<string> {
    const opponents = new Set<string>();
    for (const c of this.roundMatches(roundNumber)) {
      const [x, y] = [this.teamSquadId(c.team1Id), this.teamSquadId(c.team2Id)];
      if (x === squadId && y) opponents.add(y);
      if (y === squadId && x) opponents.add(x);
    }
    return opponents;
  }

  /** Coach B candidates: in team format, only coaches of the squad currently facing coach A's squad. */
  swapCandidates(roundNumber: number): { teamId: string; label: string }[] {
    const coaches = this.roundCoaches(roundNumber).filter((coach) => coach.teamId !== this.swapTeamId1);
    if (!this.isTeamFormat || !this.swapTeamId1) return coaches;
    const opponentSquads = this.roundOpponentSquads(roundNumber, this.teamSquadId(this.swapTeamId1));
    return coaches.filter((coach) => opponentSquads.has(this.teamSquadId(coach.teamId) ?? ''));
  }

  onSwapTeam1Change(roundNumber: number): void {
    if (!this.swapCandidates(roundNumber).some((coach) => coach.teamId === this.swapTeamId2)) this.swapTeamId2 = '';
  }

  /** Every squad, labeled with the squad(s) it currently faces, for the squad-pairing pickers. */
  roundSquads(roundNumber: number): { squadId: string; label: string }[] {
    return (this.tournament?.squads ?? []).map((squad) => {
      const opponents = Array.from(this.roundOpponentSquads(roundNumber, squad.id)).map((id) => this.squadName(id));
      return { squadId: squad.id, label: `${squad.name} (vs ${opponents.join(', ') || '—'})` };
    });
  }

  private static hasPair(pairs: [string, string][] | undefined, a: string | null, b: string | null): boolean {
    return (pairs ?? []).some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  }

  isLockedMatch(round: RoundInfo, teamId1: string, teamId2: string): boolean {
    return AdminDashboardComponent.hasPair(round.lockedPairs, teamId1, teamId2);
  }

  isLockedSquadMatch(round: RoundInfo, teamId1: string, teamId2: string): boolean {
    return AdminDashboardComponent.hasPair(round.lockedSquadPairs, this.teamSquadId(teamId1), this.teamSquadId(teamId2));
  }

  lockCount(round: RoundInfo): number {
    return (round.lockedPairs?.length ?? 0) + (this.isTeamFormat ? (round.lockedSquadPairs?.length ?? 0) : 0);
  }

  /** Round 1 of a swiss tournament, still in draft, can be redrawn at random (see rerandomizeRound in the backend). */
  canRedrawRound(round: RoundInfo): boolean {
    const t = this.tournament;
    if (!t || t.mode !== 'swiss') return false;
    return round.number === 1 && round.status === 'draft' && t.rounds.length === 1;
  }

  get isTeamFormat(): boolean {
    return this.tournament?.format === 'team';
  }

  get isPoolsKnockout(): boolean {
    return this.tournament?.mode === 'pools_knockout';
  }

  teamSquadId(teamId: string): string | null {
    return this.derived.teamsById.get(teamId)?.squadId ?? null;
  }

  teamPoolId(teamId: string): string | null {
    return this.derived.teamsById.get(teamId)?.poolId ?? null;
  }

  teamRace(teamId: string): string {
    return this.derived.teamsById.get(teamId)?.race ?? '—';
  }

  squadName(squadId: string | null): string {
    if (!squadId) return '—';
    return this.derived.squadsById.get(squadId)?.name ?? '—';
  }

  poolName(poolId: string | null): string {
    if (!poolId) return '—';
    return this.derived.poolsById.get(poolId)?.name ?? '—';
  }

  /**
   * Round cards show the coach's name as the primary identity, not the team name — for
   * team-format matches that's paired with the race inline (a third "team name" identity on top
   * of coach+squad isn't the meaningful unit there); for individual-format matches the race is
   * shown separately as a subtext line instead (see the template) rather than the team name.
   */
  matchPrimaryLabel(teamId: string): string {
    if (!this.isTeamFormat) return this.teamCoach(teamId);
    return `${this.teamCoach(teamId)} (${this.teamRace(teamId)})`;
  }

  private squadPairKey(c: PublicTournament['challenges'][number]): string {
    return [this.teamSquadId(c.team1Id) ?? '', this.teamSquadId(c.team2Id) ?? ''].sort().join('|');
  }

  /**
   * Clusters a round's matches by squad pairing so every member of a given squad-pair confrontation
   * renders stacked together, even if the underlying array isn't already in that order (e.g. after
   * an admin match swap) — this actively regroups rather than just detecting already-adjacent runs,
   * so it can't be defeated by array order. Groups keep the order the round was generated in (squad
   * standings at generation time) and the left side is the squad of the group's first match's team1,
   * so a table number and its sides never move while results come in — ordering by the live squad
   * standings would renumber the tables after every result. Same logic as the
   * public scoreboard's roundMatchGroups.
   */
  /** Pool-phase rounds only (round number <= poolRoundCount) — groups matches by pool, in pool order. */
  private poolRoundMatchGroups(matches: PublicTournament['challenges']): RoundMatchRow[] {
    const groupsByPool = new Map<string, PublicTournament['challenges']>();
    for (const challenge of matches) {
      const poolId = this.teamPoolId(challenge.team1Id) ?? '';
      if (!groupsByPool.has(poolId)) groupsByPool.set(poolId, []);
      groupsByPool.get(poolId)!.push(challenge);
    }
    const poolOrder = (this.tournament?.pools ?? []).map((p) => p.id);
    const orderedPoolIds = Array.from(groupsByPool.keys()).sort((a, b) => poolOrder.indexOf(a) - poolOrder.indexOf(b));

    const rows: RoundMatchRow[] = [];
    orderedPoolIds.forEach((poolId, groupIndex) => {
      groupsByPool.get(poolId)!.forEach((challenge, i) => {
        rows.push({
          challenge,
          groupStart: i === 0 && groupIndex > 0,
          groupIndex,
          groupLabel: i === 0 ? this.poolName(poolId) : undefined,
          tableNumber: rows.length + 1,
          leftTeamId: challenge.team1Id,
          rightTeamId: challenge.team2Id,
          leftTd: challenge.result?.team1Td ?? null,
          rightTd: challenge.result?.team2Td ?? null,
          leftCas: challenge.result?.team1Cas ?? null,
          rightCas: challenge.result?.team2Cas ?? null,
        });
      });
    });
    return rows;
  }

  /** " — triangle avec X" when this confrontation is part of the round's triangle (odd number of squads). */
  private triangleSuffix(opponents: Map<string, Set<string>>, squadA: string, squadB: string): string {
    const third = triangleThirdSquad(opponents, squadA, squadB);
    return third ? ` — triangle avec ${this.squadName(third)}` : '';
  }

  roundMatchGroups(roundNumber: number): RoundMatchRow[] {
    const matches = this.roundMatches(roundNumber);
    if (this.isPoolsKnockout && this.tournament?.poolRoundCount !== null && roundNumber <= (this.tournament?.poolRoundCount ?? 0)) {
      return this.poolRoundMatchGroups(matches);
    }
    if (!this.isTeamFormat) {
      return matches.map((challenge, i) => ({
        challenge,
        groupStart: false,
        groupIndex: 0,
        tableNumber: i + 1,
        leftTeamId: challenge.team1Id,
        rightTeamId: challenge.team2Id,
        leftTd: challenge.result?.team1Td ?? null,
        rightTd: challenge.result?.team2Td ?? null,
        leftCas: challenge.result?.team1Cas ?? null,
        rightCas: challenge.result?.team2Cas ?? null,
      }));
    }

    const groupsByKey = new Map<string, PublicTournament['challenges']>();
    for (const challenge of matches) {
      const key = this.squadPairKey(challenge);
      if (!groupsByKey.has(key)) groupsByKey.set(key, []);
      groupsByKey.get(key)!.push(challenge);
    }

    const opponents = roundSquadOpponents(matches, (teamId) => this.teamSquadId(teamId));
    // Map iteration follows insertion, i.e. each confrontation's first match in the round's array order.
    const rows: RoundMatchRow[] = [];
    Array.from(groupsByKey.keys()).forEach((key, groupIndex) => {
      const [squadX, squadY] = key.split('|');
      const group = groupsByKey.get(key)!;
      const anchorSquad = this.teamSquadId(group[0].team1Id) === squadY ? squadY : squadX;
      group.forEach((challenge, i) => {
        const team1IsAnchor = this.teamSquadId(challenge.team1Id) === anchorSquad;
        const otherSquad = anchorSquad === squadX ? squadY : squadX;
        rows.push({
          challenge,
          groupStart: i === 0 && groupIndex > 0,
          groupIndex,
          groupLabel:
            i === 0 ? `Table ${groupIndex + 1} : ${this.squadName(anchorSquad)} vs ${this.squadName(otherSquad)}${this.triangleSuffix(opponents, anchorSquad, otherSquad)}` : undefined,
          leftTeamId: team1IsAnchor ? challenge.team1Id : challenge.team2Id,
          rightTeamId: team1IsAnchor ? challenge.team2Id : challenge.team1Id,
          leftTd: challenge.result ? (team1IsAnchor ? challenge.result.team1Td : challenge.result.team2Td) : null,
          rightTd: challenge.result ? (team1IsAnchor ? challenge.result.team2Td : challenge.result.team1Td) : null,
          leftCas: challenge.result ? (team1IsAnchor ? challenge.result.team1Cas : challenge.result.team2Cas) : null,
          rightCas: challenge.result ? (team1IsAnchor ? challenge.result.team2Cas : challenge.result.team1Cas) : null,
        });
      });
    });
    return rows;
  }

  async generateRound(): Promise<void> {
    this.roundBusy = true;
    this.roundError = null;
    try {
      this.tournament = await this.api.generateRound(this.tournamentId, this.token);
    } catch (err) {
      this.roundError = extractErrorMessage(err);
    } finally {
      this.roundBusy = false;
    }
  }

  async swapMatches(roundNumber: number): Promise<void> {
    if (!this.swapTeamId1 || !this.swapTeamId2) return;
    this.roundBusy = true;
    this.roundError = null;
    try {
      this.tournament = await this.api.swapRoundMatches(
        this.tournamentId,
        this.token,
        roundNumber,
        this.swapTeamId1,
        this.swapTeamId2
      );
      this.swapTeamId1 = '';
      this.swapTeamId2 = '';
    } catch (err) {
      this.roundError = extractErrorMessage(err);
    } finally {
      this.roundBusy = false;
    }
  }

  async pairSquads(roundNumber: number): Promise<void> {
    if (!this.pairSquadId1 || !this.pairSquadId2) return;
    this.roundBusy = true;
    this.roundError = null;
    try {
      this.tournament = await this.api.pairRoundSquads(
        this.tournamentId,
        this.token,
        roundNumber,
        this.pairSquadId1,
        this.pairSquadId2
      );
      this.pairSquadId1 = '';
      this.pairSquadId2 = '';
    } catch (err) {
      this.roundError = extractErrorMessage(err);
    } finally {
      this.roundBusy = false;
    }
  }

  async rerandomizeRound(roundNumber: number): Promise<void> {
    this.roundBusy = true;
    this.roundError = null;
    try {
      this.tournament = await this.api.rerandomizeRound(this.tournamentId, this.token, roundNumber, this.redrawKeepLocks);
    } catch (err) {
      this.roundError = extractErrorMessage(err);
    } finally {
      this.roundBusy = false;
    }
  }

  async launchRound(roundNumber: number): Promise<void> {
    this.roundBusy = true;
    this.roundError = null;
    try {
      this.tournament = await this.api.launchRound(this.tournamentId, this.token, roundNumber);
    } catch (err) {
      this.roundError = extractErrorMessage(err);
    } finally {
      this.roundBusy = false;
    }
  }

  /**
   * Cancelling (deleting) a round is only offered for the LAST round, and only while nothing in it
   * has been played yet — see cancelRound in the backend for why (an earlier round's pairing is
   * already baked into any later round that exists, and cancelling doesn't undo a played match).
   */
  canCancelRound(round: RoundInfo): boolean {
    const rounds = this.tournament?.rounds ?? [];
    const isLastRound = rounds.length > 0 && rounds[rounds.length - 1].number === round.number;
    if (!isLastRound) return false;
    return !this.roundMatches(round.number).some((c) => c.result !== null);
  }

  async cancelRound(roundNumber: number): Promise<void> {
    if (!confirm(`Supprimer la ronde ${roundNumber} et ses appariements ?`)) return;
    this.roundBusy = true;
    this.roundError = null;
    try {
      this.tournament = await this.api.cancelRound(this.tournamentId, this.token, roundNumber);
    } catch (err) {
      this.roundError = extractErrorMessage(err);
    } finally {
      this.roundBusy = false;
    }
  }

  squadBusy = false;
  squadError: string | null = null;
  newSquadName = '';
  renamingSquadId: string | null = null;
  renameSquadDraft = '';
  squadScoringDraft: SquadScoringConfig | null = null;
  savingSquadScoring = false;

  squadMemberCount(squadId: string): number {
    return this.derived.squadMemberCounts.get(squadId) ?? 0;
  }

  async createSquad(): Promise<void> {
    const name = this.newSquadName.trim();
    if (!name) return;
    this.squadBusy = true;
    this.squadError = null;
    try {
      this.tournament = await this.api.createSquad(this.tournamentId, this.token, name);
      this.newSquadName = '';
    } catch (err) {
      this.squadError = extractErrorMessage(err);
    } finally {
      this.squadBusy = false;
    }
  }

  startRenameSquad(squadId: string, currentName: string): void {
    this.renamingSquadId = squadId;
    this.renameSquadDraft = currentName;
  }

  cancelRenameSquad(): void {
    this.renamingSquadId = null;
  }

  async saveRenameSquad(squadId: string): Promise<void> {
    const name = this.renameSquadDraft.trim();
    if (!name) return;
    this.squadBusy = true;
    this.squadError = null;
    try {
      this.tournament = await this.api.renameSquad(this.tournamentId, this.token, squadId, name);
      this.renamingSquadId = null;
    } catch (err) {
      this.squadError = extractErrorMessage(err);
    } finally {
      this.squadBusy = false;
    }
  }

  async deleteSquad(squadId: string): Promise<void> {
    this.squadBusy = true;
    this.squadError = null;
    try {
      this.tournament = await this.api.deleteSquad(this.tournamentId, this.token, squadId);
    } catch (err) {
      this.squadError = extractErrorMessage(err);
    } finally {
      this.squadBusy = false;
    }
  }

  async assignTeamSquad(teamId: string, squadId: string): Promise<void> {
    this.squadBusy = true;
    this.squadError = null;
    try {
      this.tournament = await this.api.assignTeamSquad(this.tournamentId, this.token, teamId, squadId || null);
    } catch (err) {
      this.squadError = extractErrorMessage(err);
    } finally {
      this.squadBusy = false;
    }
  }

  squadTiebreakerLabel(criterion: SquadTiebreakerCriterion): string {
    return SQUAD_TIEBREAKER_LABELS[criterion] ?? criterion;
  }

  availableSquadTiebreakers(): SquadTiebreakerCriterion[] {
    const used = new Set(this.squadScoringDraft?.tiebreakers ?? []);
    return ALL_SQUAD_TIEBREAKER_CRITERIA.filter((c) => !used.has(c));
  }

  addSquadTiebreaker(criterion: string): void {
    const draft = this.squadScoringDraft;
    if (!draft || !ALL_SQUAD_TIEBREAKER_CRITERIA.includes(criterion as SquadTiebreakerCriterion)) return;
    draft.tiebreakers = [...(draft.tiebreakers ?? []), criterion as SquadTiebreakerCriterion];
  }

  removeSquadTiebreaker(index: number): void {
    this.squadScoringDraft?.tiebreakers?.splice(index, 1);
  }

  moveSquadTiebreaker(index: number, direction: -1 | 1): void {
    const list = this.squadScoringDraft?.tiebreakers;
    if (!list) return;
    const target = index + direction;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
  }

  private squadOutcomesCache: { size: number; lists: SquadOutcomeLists } | null = null;

  /** Board records of a full squad, for the big-win / small-loss pickers; null when the squad size is unknown. */
  squadOutcomes(): SquadOutcomeLists | null {
    const size = this.tournament?.squadSize;
    if (!size) return null;
    if (this.squadOutcomesCache?.size !== size) this.squadOutcomesCache = { size, lists: squadOutcomesFor(size) };
    return this.squadOutcomesCache.lists;
  }

  isSquadOutcomeSelected(field: 'bigWinOutcomes' | 'smallLossOutcomes', key: string): boolean {
    return this.squadScoringDraft?.[field].includes(key) ?? false;
  }

  toggleSquadOutcome(field: 'bigWinOutcomes' | 'smallLossOutcomes', key: string, selected: boolean): void {
    const draft = this.squadScoringDraft;
    if (!draft) return;
    const rest = draft[field].filter((k) => k !== key);
    draft[field] = selected ? [...rest, key] : rest;
  }

  /** Preset: every win without a single lost board is a big win (5-0-0, 4-1-0, 3-2-0 … in squads of 5). */
  selectBigWinsWithoutLoss(): void {
    const lists = this.squadOutcomes();
    if (this.squadScoringDraft && lists) {
      this.squadScoringDraft.bigWinOutcomes = lists.wins.filter((o) => o.losses === 0).map((o) => o.key);
    }
  }

  /** Preset: every loss by a single board is a small loss (2-0-3, 1-2-2, 0-4-1 in squads of 5). */
  selectSmallLossesByOne(): void {
    const lists = this.squadOutcomes();
    if (this.squadScoringDraft && lists) {
      this.squadScoringDraft.smallLossOutcomes = lists.losses.filter((o) => o.losses - o.wins === 1).map((o) => o.key);
    }
  }

  clearSquadOutcomes(field: 'bigWinOutcomes' | 'smallLossOutcomes'): void {
    if (this.squadScoringDraft) this.squadScoringDraft[field] = [];
  }

  trackBySquadOutcome(_index: number, outcome: SquadOutcome): string {
    return outcome.key;
  }

  async saveSquadScoring(): Promise<void> {
    if (!this.squadScoringDraft) return;
    this.savingSquadScoring = true;
    this.squadError = null;
    try {
      this.tournament = await this.api.updateSquadScoring(this.tournamentId, this.token, this.squadScoringDraft);
      if (this.tournament.squadScoring) this.squadScoringDraft = cloneSquadScoring(this.tournament.squadScoring);
    } catch (err) {
      this.squadError = extractErrorMessage(err);
    } finally {
      this.savingSquadScoring = false;
    }
  }

  poolBusy = false;
  poolError: string | null = null;

  poolMemberCount(poolId: string): number {
    return this.derived.poolMemberCounts.get(poolId) ?? 0;
  }

  poolStandings(poolId: string): StandingEntry[] {
    return this.tournament?.poolStandings.find((p) => p.poolId === poolId)?.standings ?? [];
  }

  poolTeams(poolId: string): AdminTeamView[] {
    return (this.tournament?.teams ?? []).filter((t) => t.poolId === poolId);
  }

  get unassignedTeams(): AdminTeamView[] {
    return (this.tournament?.teams ?? []).filter((t) => t.poolId === null);
  }

  async generatePools(): Promise<void> {
    this.poolBusy = true;
    this.poolError = null;
    try {
      this.tournament = await this.api.generatePools(this.tournamentId, this.token);
    } catch (err) {
      this.poolError = extractErrorMessage(err);
    } finally {
      this.poolBusy = false;
    }
  }

  async assignTeamPool(teamId: string, poolId: string): Promise<void> {
    this.poolBusy = true;
    this.poolError = null;
    try {
      this.tournament = await this.api.assignTeamPool(this.tournamentId, this.token, teamId, poolId || null);
    } catch (err) {
      this.poolError = extractErrorMessage(err);
    } finally {
      this.poolBusy = false;
    }
  }

  renamingPoolId: string | null = null;
  renamePoolDraft = '';

  startRenamePool(poolId: string, currentName: string): void {
    this.renamingPoolId = poolId;
    this.renamePoolDraft = currentName;
  }

  cancelRenamePool(): void {
    this.renamingPoolId = null;
  }

  async saveRenamePool(poolId: string): Promise<void> {
    const name = this.renamePoolDraft.trim();
    if (!name) return;
    this.poolBusy = true;
    this.poolError = null;
    try {
      this.tournament = await this.api.renamePool(this.tournamentId, this.token, poolId, name);
      this.renamingPoolId = null;
    } catch (err) {
      this.poolError = extractErrorMessage(err);
    } finally {
      this.poolBusy = false;
    }
  }

  /** True once every pool round has been generated and every one of its matches is completed. */
  get poolPhaseComplete(): boolean {
    const t = this.tournament;
    if (!t || t.poolRoundCount === null) return false;
    if (t.rounds.length < t.poolRoundCount) return false;
    const poolChallenges = t.challenges.filter((c) => c.round !== null && c.round <= t.poolRoundCount!);
    return poolChallenges.length > 0 && poolChallenges.every((c) => c.status === 'completed');
  }

  get canLaunchKnockout(): boolean {
    return this.isPoolsKnockout && this.poolPhaseComplete && this.tournament?.bracket === null;
  }

  async launchKnockoutPhase(): Promise<void> {
    this.roundBusy = true;
    this.roundError = null;
    try {
      this.tournament = await this.api.launchKnockoutPhase(this.tournamentId, this.token);
    } catch (err) {
      this.roundError = extractErrorMessage(err);
    } finally {
      this.roundBusy = false;
    }
  }

  readonly bracketTeamName = (teamId: string) => this.teamName(teamId);
  readonly bracketTeamRace = (teamId: string) => this.teamRace(teamId);

  readonly allTiebreakerCriteria = ALL_TIEBREAKER_CRITERIA;

  individualScoringDraft: IndividualScoringConfig | null = null;
  savingIndividualScoring = false;
  individualScoringError: string | null = null;

  /** Enabled custom stat categories only — a disabled one has no meaningful net-diff to break ties with. */
  private get enabledCustomStatCategories(): CustomStatCategoryConfig[] {
    return this.tournament?.customStatCategories.filter((c) => c.enabled) ?? [];
  }

  tiebreakerLabel(criterion: TiebreakerCriterion): string {
    const categoryId = customTiebreakerCategoryId(criterion);
    if (categoryId !== null) {
      const category = this.tournament?.customStatCategories.find((c) => c.id === categoryId);
      return category ? `${category.name} (différentiel)` : 'Statistique personnalisée supprimée';
    }
    return TIEBREAKER_LABELS[criterion as Exclude<TiebreakerCriterion, `custom:${string}`>] ?? criterion;
  }

  availableTiebreakers(): TiebreakerCriterion[] {
    const used = new Set(this.individualScoringDraft?.tiebreakers ?? []);
    const builtins = this.allTiebreakerCriteria.filter((c) => !used.has(c));
    const customs = this.enabledCustomStatCategories
      .map((c) => customTiebreakerCriterion(c.id))
      .filter((c) => !used.has(c));
    return [...builtins, ...customs];
  }

  addTiebreaker(criterion: string): void {
    if (!criterion || !this.individualScoringDraft) return;
    const categoryId = customTiebreakerCategoryId(criterion as TiebreakerCriterion);
    const valid =
      this.allTiebreakerCriteria.includes(criterion as TiebreakerCriterion) ||
      (categoryId !== null && this.enabledCustomStatCategories.some((c) => c.id === categoryId));
    if (!valid) return;
    this.individualScoringDraft.tiebreakers.push(criterion as TiebreakerCriterion);
  }

  removeTiebreaker(index: number): void {
    this.individualScoringDraft?.tiebreakers.splice(index, 1);
  }

  moveTiebreaker(index: number, direction: -1 | 1): void {
    const list = this.individualScoringDraft?.tiebreakers;
    if (!list) return;
    const target = index + direction;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
  }

  async saveIndividualScoring(): Promise<void> {
    if (!this.individualScoringDraft) return;
    this.savingIndividualScoring = true;
    this.individualScoringError = null;
    try {
      this.tournament = await this.api.updateIndividualScoring(this.tournamentId, this.token, this.individualScoringDraft);
      this.individualScoringDraft = cloneIndividualScoring(this.tournament.individualScoring);
    } catch (err) {
      this.individualScoringError = extractErrorMessage(err);
    } finally {
      this.savingIndividualScoring = false;
    }
  }

  // ---- Replacements (team format, Urgences tab) ----

  readonly raceOptions = RACES;
  replaceOutTeamId = '';
  replaceMode: 'new' | 'existing' = 'new';
  replaceInTeamId = '';
  replaceCoachName = '';
  replaceRace = '';
  replaceNafNumber = '';
  replacementBusy = false;
  replacementError: string | null = null;

  /** The round a replacement made now applies to: the draft round if there is one, else the next one to generate (same rule as the backend). */
  get nextReplacementRound(): number | null {
    const t = this.tournament;
    if (!t || t.mode !== 'swiss') return null;
    const last = t.rounds[t.rounds.length - 1];
    const round = last && last.status === 'draft' ? last.number : t.rounds.length + 1;
    return t.roundCount !== null && round > t.roundCount ? null : round;
  }

  private playingInRound(squadId: string, round: number): Set<string> {
    return activeSquadMembers(this.tournament?.teams ?? [], this.tournament?.replacements, squadId, round);
  }

  /** Coaches playing the next round, the ones that can be replaced, sorted by squad then coach. */
  replaceableCoaches(): { teamId: string; label: string }[] {
    const round = this.nextReplacementRound;
    if (round === null || !this.tournament) return [];
    if (!this.isTeamFormat) {
      return [...activeCoaches(this.tournament.teams, this.tournament.replacements, round)]
        .map((teamId) => ({ teamId, label: `${this.teamCoach(teamId)} (${this.teamRace(teamId)})` }))
        .sort((a, b) => a.label.localeCompare(b.label));
    }
    return this.tournament.squads
      .flatMap((sq) => [...this.playingInRound(sq.id, round)].map((teamId) => ({ teamId, label: `${this.squadName(sq.id)} — ${this.teamCoach(teamId)}` })))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  /** Coaches not playing that round (of the replaced coach's squad, in team format), e.g. the original coming back. */
  benchCoaches(): { teamId: string; label: string }[] {
    const round = this.nextReplacementRound;
    if (round === null || !this.replaceOutTeamId || !this.tournament) return [];
    const squadId = this.isTeamFormat ? this.teamSquadId(this.replaceOutTeamId) : null;
    const playing = activeCoaches(this.tournament.teams, this.tournament.replacements, round);
    return this.tournament.teams
      .filter((tm) => (!this.isTeamFormat || tm.squadId === squadId) && !playing.has(tm.id))
      .map((tm) => ({ teamId: tm.id, label: `${tm.coachName} (${tm.race})` }));
  }

  displayedRoundIsDraft(round: number): boolean {
    return this.tournament?.rounds.find((r) => r.number === round)?.status === 'draft';
  }

  canSubmitReplacement(): boolean {
    if (!this.replaceOutTeamId || this.replacementBusy) return false;
    if (this.replaceMode === 'existing') return !!this.replaceInTeamId;
    return !!this.replaceCoachName.trim() && !!this.replaceRace;
  }

  async submitReplacement(): Promise<void> {
    if (!this.canSubmitReplacement()) return;
    this.replacementBusy = true;
    this.replacementError = null;
    try {
      this.tournament = await this.api.createReplacement(this.tournamentId, this.token, {
        outTeamId: this.replaceOutTeamId,
        ...(this.replaceMode === 'existing'
          ? { inTeamId: this.replaceInTeamId }
          : { substitute: { coachName: this.replaceCoachName.trim(), race: this.replaceRace, nafNumber: this.replaceNafNumber.trim() || null } }),
      });
      this.replaceOutTeamId = '';
      this.replaceInTeamId = '';
      this.replaceCoachName = '';
      this.replaceRace = '';
      this.replaceNafNumber = '';
    } catch (err) {
      this.replacementError = extractErrorMessage(err);
    } finally {
      this.replacementBusy = false;
    }
  }

  /** Latest first. */
  replacementsList(): Replacement[] {
    return [...(this.tournament?.replacements ?? [])].sort((a, b) => b.round - a.round || b.createdAt.localeCompare(a.createdAt));
  }

  canRevertReplacement(r: Replacement): boolean {
    return this.tournament?.rounds.find((round) => round.number === r.round)?.status !== 'launched';
  }

  async revertReplacement(r: Replacement): Promise<void> {
    if (!confirm(`Annuler le remplacement de ${this.teamCoach(r.outTeamId)} par ${this.teamCoach(r.inTeamId)} ?`)) return;
    this.replacementBusy = true;
    this.replacementError = null;
    try {
      this.tournament = await this.api.deleteReplacement(this.tournamentId, this.token, r.id);
    } catch (err) {
      this.replacementError = extractErrorMessage(err);
    } finally {
      this.replacementBusy = false;
    }
  }

  // ---- Roster tiers (the `roster_tier` tiebreaker) ----

  rosterTiersDraft: RosterTier[] = resolveRosterTiers(null);
  savingRosterTiers = false;
  rosterTiersError: string | null = null;
  readonly maxRosterTiers = MAX_ROSTER_TIERS;

  /** The "Tiering" tab only shows once a roster-tier tiebreaker is picked (individual or squad). */
  get showTieringTab(): boolean {
    const individual = this.individualScoringDraft;
    const individualUsesTier = individual?.mode === 'points_tiebreaker' && individual.tiebreakers.includes('roster_tier');
    const squadUsesTier = this.tournament?.format === 'team' && !!this.squadScoringDraft?.tiebreakers?.includes('roster_tier');
    return individualUsesTier || squadUsesTier;
  }

  raceLabel(race: string): string {
    return FRENCH_RACE_LABELS[race as (typeof RACES)[number]] ?? race;
  }

  /** Coaches registered with this race, shown next to it so the admin sees which tiers actually matter. */
  raceTeamCount(race: string): number {
    return this.tournament?.teams.filter((tm) => tm.race === race).length ?? 0;
  }

  /** Known races plus any race typed by a registered coach, that sit in no tier (they count as tier 0). */
  unassignedRaces(): string[] {
    const assigned = new Set(this.rosterTiersDraft.flatMap((tier) => tier.races));
    const all = new Set<string>([...RACES, ...(this.tournament?.teams.map((tm) => tm.race) ?? [])]);
    return [...all].filter((race) => race && race !== '—' && !assigned.has(race)).sort((a, b) => this.raceLabel(a).localeCompare(this.raceLabel(b)));
  }

  /** Moves `race` to tier `target` (-1 = no tier). */
  moveRace(race: string, target: number | string): void {
    const targetIndex = Number(target);
    for (const tier of this.rosterTiersDraft) tier.races = tier.races.filter((r) => r !== race);
    this.rosterTiersDraft[targetIndex]?.races.push(race);
  }

  addRosterTier(): void {
    if (this.rosterTiersDraft.length >= MAX_ROSTER_TIERS) return;
    this.rosterTiersDraft.push({ races: [] });
  }

  /** Only empty tiers can be removed, so no race silently changes tier. */
  removeRosterTier(index: number): void {
    if (this.rosterTiersDraft.length <= 1 || this.rosterTiersDraft[index]?.races.length) return;
    this.rosterTiersDraft.splice(index, 1);
  }

  resetRosterTiers(): void {
    this.rosterTiersDraft = resolveRosterTiers(DEFAULT_ROSTER_TIERS);
  }

  async saveRosterTiers(): Promise<void> {
    this.savingRosterTiers = true;
    this.rosterTiersError = null;
    try {
      this.tournament = await this.api.updateRosterTiers(this.tournamentId, this.token, { tiers: this.rosterTiersDraft });
      this.rosterTiersDraft = resolveRosterTiers(this.tournament.rosterTiers);
    } catch (err) {
      this.rosterTiersError = extractErrorMessage(err);
    } finally {
      this.savingRosterTiers = false;
    }
  }

  // ---- Match sheet config (built-in cas/agg/td display) ----

  matchSheetDraft: MatchSheetConfig | null = null;
  savingMatchSheet = false;
  matchSheetError: string | null = null;
  readonly customStatPrecisionMaxLength = CUSTOM_STAT_PRECISION_MAX_LENGTH;

  async saveMatchSheetConfig(): Promise<void> {
    if (!this.matchSheetDraft) return;
    this.savingMatchSheet = true;
    this.matchSheetError = null;
    try {
      this.tournament = await this.api.updateMatchSheetConfig(this.tournamentId, this.token, this.matchSheetDraft);
      this.matchSheetDraft = cloneMatchSheetConfig(this.tournament.matchSheetConfig);
    } catch (err) {
      this.matchSheetError = extractErrorMessage(err);
    } finally {
      this.savingMatchSheet = false;
    }
  }

  // ---- Custom stat categories ----

  customStatCategoriesDraft: CustomStatCategoryConfig[] = [];
  savingCustomStatCategories = false;
  customStatCategoriesError: string | null = null;
  readonly maxCustomStatCategories = MAX_CUSTOM_STAT_CATEGORIES;
  readonly customStatNameMaxLength = CUSTOM_STAT_NAME_MAX_LENGTH;
  readonly minScoringMultiplier = MIN_SCORING_MULTIPLIER;
  readonly maxScoringMultiplier = MAX_SCORING_MULTIPLIER;

  addCustomStatCategory(): void {
    if (this.customStatCategoriesDraft.length >= this.maxCustomStatCategories) return;
    this.customStatCategoriesDraft.push({
      id: `new-${Date.now()}-${this.customStatCategoriesDraft.length}`,
      name: '',
      precision: '',
      enabled: true,
      rawPoints: { basis: 'total', multiplier: 0 },
    });
  }

  removeCustomStatCategory(index: number): void {
    this.customStatCategoriesDraft.splice(index, 1);
  }

  async saveCustomStatCategories(): Promise<void> {
    this.savingCustomStatCategories = true;
    this.customStatCategoriesError = null;
    try {
      const existingIds = new Set((this.tournament?.customStatCategories ?? []).map((c) => c.id));
      const categories: CustomStatCategoryInput[] = this.customStatCategoriesDraft.map((c) => ({
        id: existingIds.has(c.id) ? c.id : undefined,
        name: c.name,
        precision: c.precision,
        enabled: c.enabled,
        rawPoints: c.rawPoints,
      }));
      this.tournament = await this.api.updateCustomStatCategories(this.tournamentId, this.token, { categories });
      this.customStatCategoriesDraft = cloneCustomStatCategories(this.tournament.customStatCategories);
      this.individualScoringDraft = cloneIndividualScoring(this.tournament.individualScoring);
    } catch (err) {
      this.customStatCategoriesError = extractErrorMessage(err);
    } finally {
      this.savingCustomStatCategories = false;
    }
  }

  // ---- Match sheet preview (fed with fake teams so the admin can see the resulting sheet) ----

  readonly previewTeam1Id = 'preview-team-1';
  readonly previewTeam2Id = 'preview-team-2';
}
