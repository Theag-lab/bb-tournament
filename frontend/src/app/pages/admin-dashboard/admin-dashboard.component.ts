import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  ALL_TIEBREAKER_CRITERIA,
  ORGANIZER_COACH_NAME_MAX_LENGTH,
  TOURNAMENT_DESCRIPTION_MAX_LENGTH,
  type AdminTeamView,
  type AdminTournamentView,
  type IndividualScoringConfig,
  type PublicTournament,
  type RoundInfo,
  type Squad,
  type SquadScoringConfig,
  type SubmitResultRequest,
  type TiebreakerCriterion,
} from '@bb-tournament/shared';
import { ApiService } from '../../core/api.service';
import { extractErrorMessage } from '../../core/http-error';
import { copyToClipboard, participantUrl, rosterImageUrl, scoreboardUrl } from '../../core/links';
import { renderMarkdown } from '../../core/markdown';
import { rosterStatusLabel } from '../../core/roster-status';
import { MatchResultFormComponent } from '../../shared/match-result-form/match-result-form.component';

const POLL_INTERVAL_MS = 15000;

type AdminTab = 'overview' | 'rounds' | 'teams' | 'squads' | 'challenges';

function cloneIndividualScoring(config: IndividualScoringConfig): IndividualScoringConfig {
  return {
    ...config,
    tiebreakers: [...config.tiebreakers],
    td: { ...config.td },
    cas: { ...config.cas },
    agg: { ...config.agg },
  };
}

export const TIEBREAKER_LABELS: Record<TiebreakerCriterion, string> = {
  fewest_td_conceded: 'TD encaissés (moins = mieux)',
  opponent_score: "Force du calendrier (Buchholz)",
  net_td: 'Différentiel de TD',
  net_cas: 'Différentiel de casses',
  net_agg: "Différentiel d'agressions",
  random: 'Tirage aléatoire (stable)',
};

interface DerivedLookups {
  tournament: AdminTournamentView | null;
  teamsById: Map<string, AdminTeamView>;
  squadsById: Map<string, Squad>;
  teamsWithChallenges: Set<string>;
  squadMemberCounts: Map<string, number>;
  squadRankIndex: Map<string, number>;
}

export interface RoundMatchRow {
  challenge: PublicTournament['challenges'][number];
  groupStart: boolean;
  groupIndex: number;
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
  imports: [CommonModule, FormsModule, RouterLink, MatchResultFormComponent],
  templateUrl: './admin-dashboard.component.html',
  styleUrl: './admin-dashboard.component.scss',
})
export class AdminDashboardComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ApiService);
  private pollHandle: ReturnType<typeof setInterval> | null = null;

  tournamentId = '';
  token = '';

  tournament: AdminTournamentView | null = null;
  loading = true;
  loadError: string | null = null;

  actionError: string | null = null;
  actionBusy = false;

  copiedTeamId: string | null = null;
  scoreboardCopied = false;

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

  private derivedCache: DerivedLookups = {
    tournament: null,
    teamsById: new Map(),
    squadsById: new Map(),
    teamsWithChallenges: new Set(),
    squadMemberCounts: new Map(),
    squadRankIndex: new Map(),
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
    const teamsWithChallenges = new Set<string>();
    const squadMemberCounts = new Map<string, number>();
    for (const c of this.tournament?.challenges ?? []) {
      teamsWithChallenges.add(c.team1Id);
      teamsWithChallenges.add(c.team2Id);
    }
    for (const team of this.tournament?.teams ?? []) {
      if (!team.squadId) continue;
      squadMemberCounts.set(team.squadId, (squadMemberCounts.get(team.squadId) ?? 0) + 1);
    }
    // squadStandings is already ranked best-first — this just turns that into an O(1) rank lookup.
    const squadRankIndex = new Map<string, number>();
    (this.tournament?.squadStandings ?? []).forEach((s, i) => squadRankIndex.set(s.squadId, i));
    this.derivedCache = {
      tournament: this.tournament,
      teamsById,
      squadsById,
      teamsWithChallenges,
      squadMemberCounts,
      squadRankIndex,
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
    await this.load();
    this.pollHandle = setInterval(() => this.load(true), POLL_INTERVAL_MS);
  }

  ngOnDestroy(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
  }

  async load(silent = false): Promise<void> {
    if (!silent) this.loading = true;
    try {
      this.tournament = await this.api.getAdminTournament(this.tournamentId, this.token);
      if (!silent) {
        this.descriptionDraft = this.tournament.description;
        this.organizerCoachNameDraft = this.tournament.organizerCoachName;
        if (this.tournament.squadScoring) this.squadScoringDraft = { ...this.tournament.squadScoring };
        this.individualScoringDraft = cloneIndividualScoring(this.tournament.individualScoring);
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

  teamName(teamId: string): string {
    return this.derived.teamsById.get(teamId)?.name ?? '—';
  }

  teamCoach(teamId: string): string {
    return this.derived.teamsById.get(teamId)?.coachName ?? '—';
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

  nafExportUrl(): string {
    return this.api.nafExportUrl(this.tournamentId, this.token);
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
  swapMatchId1 = '';
  swapMatchId2 = '';

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

  get isTeamFormat(): boolean {
    return this.tournament?.format === 'team';
  }

  teamSquadId(teamId: string): string | null {
    return this.derived.teamsById.get(teamId)?.squadId ?? null;
  }

  teamRace(teamId: string): string {
    return this.derived.teamsById.get(teamId)?.race ?? '—';
  }

  squadName(squadId: string | null): string {
    if (!squadId) return '—';
    return this.derived.squadsById.get(squadId)?.name ?? '—';
  }

  /**
   * In a team-format tournament, a coach's own team name adds a third identity on top of
   * coach+squad and isn't the meaningful unit there — the round cards show "coach (race)" plus
   * the squad-vs-squad line instead, rather than the individual team name.
   */
  matchPrimaryLabel(teamId: string): string {
    if (!this.isTeamFormat) return this.teamName(teamId);
    return `${this.teamCoach(teamId)} (${this.teamRace(teamId)})`;
  }

  private squadPairKey(c: PublicTournament['challenges'][number]): string {
    return [this.teamSquadId(c.team1Id) ?? '', this.teamSquadId(c.team2Id) ?? ''].sort().join('|');
  }

  private squadRank(squadId: string | null): number {
    if (!squadId) return Infinity;
    return this.derived.squadRankIndex.get(squadId) ?? Infinity;
  }

  /**
   * Clusters a round's matches by squad pairing so every member of a given squad-pair confrontation
   * renders stacked together, even if the underlying array isn't already in that order (e.g. after
   * an admin match swap) — this actively regroups rather than just detecting already-adjacent runs,
   * so it can't be defeated by array order. Groups are then ordered by squad rank (the top-ranked
   * squad's confrontation first), and within each group the higher-ranked squad always renders on
   * the left, regardless of which side happens to be team1/team2 in the raw data. Same logic as the
   * public scoreboard's roundMatchGroups.
   */
  roundMatchGroups(roundNumber: number): RoundMatchRow[] {
    const matches = this.roundMatches(roundNumber);
    if (!this.isTeamFormat) {
      return matches.map((challenge) => ({
        challenge,
        groupStart: false,
        groupIndex: 0,
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

    const orderedKeys = Array.from(groupsByKey.keys()).sort((a, b) => {
      const bestRank = (key: string) => Math.min(...key.split('|').map((id) => this.squadRank(id)));
      return bestRank(a) - bestRank(b);
    });

    const rows: RoundMatchRow[] = [];
    orderedKeys.forEach((key, groupIndex) => {
      const [squadX, squadY] = key.split('|');
      const anchorSquad = this.squadRank(squadX) <= this.squadRank(squadY) ? squadX : squadY;
      groupsByKey.get(key)!.forEach((challenge, i) => {
        const team1IsAnchor = this.teamSquadId(challenge.team1Id) === anchorSquad;
        rows.push({
          challenge,
          groupStart: i === 0 && groupIndex > 0,
          groupIndex,
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
    if (!this.swapMatchId1 || !this.swapMatchId2) return;
    this.roundBusy = true;
    this.roundError = null;
    try {
      this.tournament = await this.api.swapRoundMatches(
        this.tournamentId,
        this.token,
        roundNumber,
        this.swapMatchId1,
        this.swapMatchId2
      );
      this.swapMatchId1 = '';
      this.swapMatchId2 = '';
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

  async saveSquadScoring(): Promise<void> {
    if (!this.squadScoringDraft) return;
    this.savingSquadScoring = true;
    this.squadError = null;
    try {
      this.tournament = await this.api.updateSquadScoring(this.tournamentId, this.token, this.squadScoringDraft);
      if (this.tournament.squadScoring) this.squadScoringDraft = { ...this.tournament.squadScoring };
    } catch (err) {
      this.squadError = extractErrorMessage(err);
    } finally {
      this.savingSquadScoring = false;
    }
  }

  readonly tiebreakerLabels = TIEBREAKER_LABELS;
  readonly allTiebreakerCriteria = ALL_TIEBREAKER_CRITERIA;

  individualScoringDraft: IndividualScoringConfig | null = null;
  savingIndividualScoring = false;
  individualScoringError: string | null = null;

  availableTiebreakers(): TiebreakerCriterion[] {
    const used = new Set(this.individualScoringDraft?.tiebreakers ?? []);
    return this.allTiebreakerCriteria.filter((c) => !used.has(c));
  }

  addTiebreaker(criterion: string): void {
    if (!criterion || !this.individualScoringDraft) return;
    if (!this.allTiebreakerCriteria.includes(criterion as TiebreakerCriterion)) return;
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
}
