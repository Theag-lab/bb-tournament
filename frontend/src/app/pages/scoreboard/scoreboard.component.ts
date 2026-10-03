import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  RACES,
  type CustomStatLeaderboard,
  type Pool,
  type PublicTeam,
  type PublicTournament,
  type Squad,
  type SquadStandingEntry,
  type StandingEntry,
} from '@bb-tournament/shared';
import { ApiService } from '../../core/api.service';
import { type BackupIdInfo, parseBackupId } from '../../core/backup';
import { extractErrorMessage } from '../../core/http-error';
import { copyToClipboard, participantUrl, rosterImageUrl, scoreboardUrl } from '../../core/links';
import { renderMarkdown } from '../../core/markdown';
import { rosterStatusLabel } from '../../core/roster-status';
import { BracketGraphComponent } from '../../shared/bracket-graph/bracket-graph.component';

const POLL_INTERVAL_MS = 60000;

interface DerivedLookups {
  tournament: PublicTournament | null;
  teamsById: Map<string, PublicTeam>;
  squadsById: Map<string, Squad>;
  poolsById: Map<string, Pool>;
  squadMemberCounts: Map<string, number>;
  squadRankIndex: Map<string, number>;
  poolMemberCounts: Map<string, number>;
}

export interface RoundMatchRow {
  challenge: PublicTournament['challenges'][number];
  groupStart: boolean;
  groupIndex: number;
  leftTeamId: string;
  rightTeamId: string;
  leftTd: number | null;
  rightTd: number | null;
}

@Component({
  selector: 'app-scoreboard',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, BracketGraphComponent],
  templateUrl: './scoreboard.component.html',
  styleUrl: './scoreboard.component.scss',
})
export class ScoreboardComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(ApiService);
  private pollHandle: ReturnType<typeof setInterval> | null = null;

  readonly races = RACES;
  readonly rosterStatusLabel = rosterStatusLabel;

  tournamentId = '';
  backupInfo: BackupIdInfo | null = null;
  tournament: PublicTournament | null = null;
  loading = true;
  error: string | null = null;

  activeTab = 'scores';
  descriptionHtml = '';

  showJoinForm = false;
  joinBusy = false;
  joinError: string | null = null;
  joinName = '';
  joinCoachName = '';
  joinRace = '';
  joinPassword = '';
  joinSquadChoice: 'existing' | 'new' = 'existing';
  joinSquadId = '';
  joinNewSquadName = '';

  createdTeam: { teamId: string; password: string } | null = null;
  copied = false;
  shareCopied = false;

  showFindForm = false;
  findCoachName = '';
  findPassword = '';
  findBusy = false;
  findError: string | null = null;

  selectedTeam: PublicTeam | null = null;

  private derivedCache: DerivedLookups = {
    tournament: null,
    teamsById: new Map(),
    squadsById: new Map(),
    poolsById: new Map(),
    squadMemberCounts: new Map(),
    squadRankIndex: new Map(),
    poolMemberCounts: new Map(),
  };

  /**
   * O(1) lookups rebuilt once per tournament reference change, instead of `.find()`/`.filter()`
   * scans of the teams/squads arrays on every template evaluation — matters once a tournament has
   * 50 teams and this page polls every 15s (each poll, and every other change-detection pass,
   * would otherwise re-scan the full arrays for every row of every table on the page).
   */
  private get derived(): DerivedLookups {
    if (this.derivedCache.tournament === this.tournament) return this.derivedCache;
    const teamsById = new Map((this.tournament?.teams ?? []).map((t) => [t.id, t]));
    const squadsById = new Map((this.tournament?.squads ?? []).map((s) => [s.id, s]));
    const poolsById = new Map((this.tournament?.pools ?? []).map((p) => [p.id, p]));
    const squadMemberCounts = new Map<string, number>();
    const poolMemberCounts = new Map<string, number>();
    for (const team of this.tournament?.teams ?? []) {
      if (team.squadId) squadMemberCounts.set(team.squadId, (squadMemberCounts.get(team.squadId) ?? 0) + 1);
      if (team.poolId) poolMemberCounts.set(team.poolId, (poolMemberCounts.get(team.poolId) ?? 0) + 1);
    }
    // squadStandings is already ranked best-first — this just turns that into an O(1) rank lookup.
    const squadRankIndex = new Map<string, number>();
    (this.tournament?.squadStandings ?? []).forEach((s, i) => squadRankIndex.set(s.squadId, i));
    this.derivedCache = {
      tournament: this.tournament,
      teamsById,
      squadsById,
      poolsById,
      squadMemberCounts,
      squadRankIndex,
      poolMemberCounts,
    };
    return this.derivedCache;
  }

  trackById(_index: number, item: { id: string }): string {
    return item.id;
  }

  trackByTeamId(_index: number, entry: { teamId: string }): string {
    return entry.teamId;
  }

  trackBySquadId(_index: number, entry: { squadId: string }): string {
    return entry.squadId;
  }

  trackByRoundMatchRow(_index: number, row: { challenge: { id: string } }): string {
    return row.challenge.id;
  }

  async ngOnInit(): Promise<void> {
    this.tournamentId = this.route.snapshot.paramMap.get('tournamentId')!;
    this.backupInfo = parseBackupId(this.tournamentId);
    await this.load();
    this.pollHandle = setInterval(() => this.load(true), POLL_INTERVAL_MS);
  }

  ngOnDestroy(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
  }

  async load(silent = false): Promise<void> {
    if (!silent) this.loading = true;
    try {
      this.tournament = await this.api.getTournament(this.tournamentId);
      this.descriptionHtml = renderMarkdown(this.tournament.description);
      this.error = null;
    } catch (err) {
      this.error = extractErrorMessage(err);
    } finally {
      this.loading = false;
    }
  }

  teamName(teamId: string): string {
    return this.derived.teamsById.get(teamId)?.name ?? '—';
  }

  teamCoach(teamId: string): string {
    return this.derived.teamsById.get(teamId)?.coachName ?? '—';
  }

  teamRace(teamId: string): string {
    return this.derived.teamsById.get(teamId)?.race ?? '—';
  }

  teamSquadId(teamId: string): string | null {
    return this.derived.teamsById.get(teamId)?.squadId ?? null;
  }

  teamPoolId(teamId: string): string | null {
    return this.derived.teamsById.get(teamId)?.poolId ?? null;
  }

  get isPoolsKnockout(): boolean {
    return this.tournament?.mode === 'pools_knockout';
  }

  poolName(poolId: string | null): string {
    if (!poolId) return '—';
    return this.derived.poolsById.get(poolId)?.name ?? '—';
  }

  poolMemberCount(poolId: string): number {
    return this.derived.poolMemberCounts.get(poolId) ?? 0;
  }

  poolStandings(poolId: string): StandingEntry[] {
    return this.tournament?.poolStandings.find((p) => p.poolId === poolId)?.standings ?? [];
  }

  get showTeamNames(): boolean {
    return this.tournament?.showTeamNames ?? true;
  }

  /** Casualties/Aggressions rankings only make sense to show if the admin actually collects them. */
  get casCollected(): boolean {
    return this.tournament?.matchSheetConfig.cas.enabled ?? true;
  }

  get aggCollected(): boolean {
    return this.tournament?.matchSheetConfig.agg.enabled ?? true;
  }

  /**
   * In a team-format tournament, a coach's own team name adds a third identity on top of
   * coach+squad and isn't the meaningful unit there — the round tables show "coach (race)" over
   * the squad name instead, rather than the individual team name.
   */
  matchPrimaryLabel(teamId: string): string {
    if (!this.isTeamFormat) return this.teamCoach(teamId);
    return `${this.teamCoach(teamId)} (${this.teamRace(teamId)})`;
  }

  /**
   * Squad name for team-format matches (structurally meaningful — that's the squad-vs-squad
   * pairing). Individual-format round tables show the race instead of the team name — more useful
   * context for a matchup than the team's name, and consistent regardless of the showTeamNames
   * display toggle (which only governs identity display elsewhere, e.g. standings).
   */
  matchSecondaryLabel(teamId: string): string {
    if (this.isTeamFormat) return this.squadName(this.teamSquadId(teamId));
    return this.teamRace(teamId);
  }

  get launchedRounds() {
    return this.tournament?.rounds.filter((r) => r.status === 'launched') ?? [];
  }

  get registrationClosed(): boolean {
    return !!this.tournament && this.tournament.mode !== 'ladder' && this.tournament.rounds.length > 0;
  }

  get roundInPreparation(): boolean {
    return !!this.tournament?.rounds.some((r) => r.status === 'draft');
  }

  freeChallenges(): PublicTournament['challenges'] {
    return this.tournament?.challenges.filter((c) => c.round === null) ?? [];
  }

  /** "TeamName (Coach) vs TeamName (Coach)", or "Coach (Race) vs Coach (Race)" when team names are hidden. */
  freeChallengeLabel(c: PublicTournament['challenges'][number]): string {
    const side = (teamId: string) =>
      this.showTeamNames ? `${this.teamName(teamId)} (${this.teamCoach(teamId)})` : `${this.teamCoach(teamId)} (${this.teamRace(teamId)})`;
    return `${side(c.team1Id)} vs ${side(c.team2Id)}`;
  }

  roundMatches(roundNumber: number): PublicTournament['challenges'] {
    return this.tournament?.challenges.filter((c) => c.round === roundNumber) ?? [];
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
   * the left, regardless of which side happens to be team1/team2 in the raw data.
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
          leftTeamId: challenge.team1Id,
          rightTeamId: challenge.team2Id,
          leftTd: challenge.result?.team1Td ?? null,
          rightTd: challenge.result?.team2Td ?? null,
        });
      });
    });
    return rows;
  }

  roundMatchGroups(roundNumber: number): RoundMatchRow[] {
    const matches = this.roundMatches(roundNumber);
    if (this.isPoolsKnockout && this.tournament?.poolRoundCount !== null && roundNumber <= (this.tournament?.poolRoundCount ?? 0)) {
      return this.poolRoundMatchGroups(matches);
    }
    if (!this.isTeamFormat) {
      return matches.map((challenge) => ({
        challenge,
        groupStart: false,
        groupIndex: 0,
        leftTeamId: challenge.team1Id,
        rightTeamId: challenge.team2Id,
        leftTd: challenge.result?.team1Td ?? null,
        rightTd: challenge.result?.team2Td ?? null,
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
        });
      });
    });
    return rows;
  }

  roundTabId(roundNumber: number): string {
    return `round-${roundNumber}`;
  }

  get isTeamFormat(): boolean {
    return this.tournament?.format === 'team';
  }

  squadMemberCount(squadId: string): number {
    return this.derived.squadMemberCounts.get(squadId) ?? 0;
  }

  /** Squads a new coach can join from the registration form — full squads are excluded. */
  availableSquads(): Squad[] {
    const squadSize = this.tournament?.squadSize;
    return (this.tournament?.squads ?? []).filter((s) => squadSize == null || this.squadMemberCount(s.id) < squadSize);
  }

  squadName(squadId: string | null): string {
    if (!squadId) return '—';
    return this.derived.squadsById.get(squadId)?.name ?? '—';
  }

  get canSubmitJoin(): boolean {
    if (!this.joinCoachName.trim() || !this.joinRace.trim() || !this.joinPassword.trim()) return false;
    if (!this.isTeamFormat) return !!this.joinName.trim();
    return this.joinSquadChoice === 'existing' ? !!this.joinSquadId : !!this.joinNewSquadName.trim();
  }

  async submitJoin(): Promise<void> {
    const name = this.joinName.trim();
    const coachName = this.joinCoachName.trim();
    const race = this.joinRace.trim();
    const password = this.joinPassword.trim();
    if (!this.canSubmitJoin) return;
    this.joinBusy = true;
    this.joinError = null;
    try {
      const res = await this.api.createTeam(this.tournamentId, {
        name: this.isTeamFormat ? undefined : name,
        coachName,
        race,
        password,
        squadId: this.isTeamFormat && this.joinSquadChoice === 'existing' ? this.joinSquadId : undefined,
        newSquadName: this.isTeamFormat && this.joinSquadChoice === 'new' ? this.joinNewSquadName.trim() : undefined,
      });
      this.createdTeam = { teamId: res.teamId, password };
      await this.load(true);
    } catch (err) {
      this.joinError = extractErrorMessage(err);
    } finally {
      this.joinBusy = false;
    }
  }

  get createdTeamUrl(): string {
    if (!this.createdTeam) return '';
    return participantUrl(this.tournamentId, this.createdTeam.teamId, this.createdTeam.password);
  }

  async copyCreatedTeamLink(): Promise<void> {
    this.copied = await copyToClipboard(this.createdTeamUrl);
  }

  async shareTournament(): Promise<void> {
    const url = scoreboardUrl(this.tournamentId);
    if (navigator.share) {
      try {
        await navigator.share({ title: this.tournament?.name ?? 'Tournoi Blood Bowl', url });
        return;
      } catch {
        // User cancelled the native share sheet, or it failed — fall back to copying below.
      }
    }
    this.shareCopied = await copyToClipboard(url);
    if (this.shareCopied) {
      setTimeout(() => (this.shareCopied = false), 2000);
    }
  }

  goToMyTeam(): void {
    if (!this.createdTeam) return;
    this.router.navigate([
      '/tournaments',
      this.tournamentId,
      'team',
      this.createdTeam.teamId,
      this.createdTeam.password,
    ]);
  }

  async submitFind(): Promise<void> {
    const coachName = this.findCoachName.trim();
    const password = this.findPassword.trim();
    if (!coachName || !password) return;
    this.findBusy = true;
    this.findError = null;
    try {
      const res = await this.api.findMyTeam(this.tournamentId, coachName, password);
      this.router.navigate(['/tournaments', this.tournamentId, 'team', res.teamId, password]);
    } catch (err) {
      this.findError = extractErrorMessage(err);
    } finally {
      this.findBusy = false;
    }
  }

  openTeam(team: PublicTeam): void {
    this.selectedTeam = team;
  }

  openTeamById(teamId: string): void {
    const team = this.derived.teamsById.get(teamId);
    if (team) this.selectedTeam = team;
  }

  closeTeam(): void {
    this.selectedTeam = null;
    this.lightboxImageUrl = null;
  }

  selectedTeamImageUrl(): string | null {
    const team = this.selectedTeam;
    if (!team?.rosterImage) return null;
    return rosterImageUrl(this.tournamentId, team.id, team.rosterImage.updatedAt);
  }

  lightboxImageUrl: string | null = null;

  openImageLightbox(): void {
    this.lightboxImageUrl = this.selectedTeamImageUrl();
  }

  closeImageLightbox(): void {
    this.lightboxImageUrl = null;
  }

  selectedTeamStanding(): StandingEntry | null {
    if (!this.selectedTeam) return null;
    return this.tournament?.standings.find((s) => s.teamId === this.selectedTeam!.id) ?? null;
  }

  selectedTeamChallenges(): PublicTournament['challenges'] {
    if (!this.selectedTeam) return [];
    const id = this.selectedTeam.id;
    return (this.tournament?.challenges.filter((c) => c.team1Id === id || c.team2Id === id) ?? [])
      .slice()
      .sort((a, b) => (b.result?.playedAt ?? b.updatedAt).localeCompare(a.result?.playedAt ?? a.updatedAt));
  }

  selectedSquad: Squad | null = null;

  openSquadById(squadId: string | null): void {
    if (!squadId) return;
    const squad = this.derived.squadsById.get(squadId);
    if (squad) this.selectedSquad = squad;
  }

  closeSquad(): void {
    this.selectedSquad = null;
  }

  /** Closes the squad modal and opens the given member's own team modal on top of it. */
  openTeamFromSquad(teamId: string): void {
    this.selectedSquad = null;
    this.openTeamById(teamId);
  }

  selectedSquadStanding(): SquadStandingEntry | null {
    if (!this.selectedSquad) return null;
    return this.tournament?.squadStandings.find((s) => s.squadId === this.selectedSquad!.id) ?? null;
  }

  selectedSquadMembers(): PublicTeam[] {
    if (!this.selectedSquad) return [];
    return (this.tournament?.teams ?? []).filter((t) => t.squadId === this.selectedSquad!.id);
  }

  /**
   * One group per round the selected squad played, last round first — each group's `matches` is
   * every board (one per member who played that round), `teamId` always the squad's own member and
   * `opponentTeamId` the other side, regardless of which one is team1/team2 on the underlying
   * challenge. `opponentSquadId` is the same for every board in a round (a squad plays exactly one
   * opposing squad per round), so it's resolved once per group for the round's title. Free
   * (non-round) challenges don't apply here (squads only play round-based squad-vs-squad matchups).
   */
  selectedSquadRoundGroups(): {
    roundNumber: number;
    opponentSquadId: string | null;
    matches: { challenge: PublicTournament['challenges'][number]; teamId: string; opponentTeamId: string }[];
  }[] {
    if (!this.selectedSquad) return [];
    const squadId = this.selectedSquad.id;
    const groups = new Map<
      number,
      { roundNumber: number; opponentSquadId: string | null; matches: { challenge: PublicTournament['challenges'][number]; teamId: string; opponentTeamId: string }[] }
    >();
    for (const c of this.tournament?.challenges ?? []) {
      if (c.round === null) continue;
      const isTeam1 = this.teamSquadId(c.team1Id) === squadId;
      const isTeam2 = this.teamSquadId(c.team2Id) === squadId;
      if (!isTeam1 && !isTeam2) continue;
      const teamId = isTeam1 ? c.team1Id : c.team2Id;
      const opponentTeamId = isTeam1 ? c.team2Id : c.team1Id;
      let group = groups.get(c.round);
      if (!group) {
        group = { roundNumber: c.round, opponentSquadId: this.teamSquadId(opponentTeamId), matches: [] };
        groups.set(c.round, group);
      }
      group.matches.push({ challenge: c, teamId, opponentTeamId });
    }
    for (const group of groups.values()) group.matches.sort((a, b) => a.teamId.localeCompare(b.teamId));
    return Array.from(groups.values()).sort((a, b) => b.roundNumber - a.roundNumber);
  }

  trackByRoundGroup(_index: number, group: { roundNumber: number }): number {
    return group.roundNumber;
  }

  trackBySquadMatchRow(_index: number, row: { challenge: { id: string } }): string {
    return row.challenge.id;
  }

  memberStanding(teamId: string): StandingEntry | null {
    return this.tournament?.standings.find((s) => s.teamId === teamId) ?? null;
  }

  opponentId(c: PublicTournament['challenges'][number], teamId: string): string {
    return c.team1Id === teamId ? c.team2Id : c.team1Id;
  }

  matchScoreLabel(c: PublicTournament['challenges'][number], teamId: string): string {
    if (!c.result) return '—';
    const mine = c.team1Id === teamId ? c.result.team1Td : c.result.team2Td;
    const theirs = c.team1Id === teamId ? c.result.team2Td : c.result.team1Td;
    return `${mine} - ${theirs}`;
  }

  matchOutcome(c: PublicTournament['challenges'][number], teamId: string): 'win' | 'draw' | 'loss' | null {
    if (!c.result) return null;
    const mine = c.team1Id === teamId ? c.result.team1Points : c.result.team2Points;
    const theirs = c.team1Id === teamId ? c.result.team2Points : c.result.team1Points;
    if (mine > theirs) return 'win';
    if (mine < theirs) return 'loss';
    return 'draw';
  }

  matchOutcomeLabel(c: PublicTournament['challenges'][number], teamId: string): string {
    const outcome = this.matchOutcome(c, teamId);
    if (outcome === 'win') return 'Victoire';
    if (outcome === 'loss') return 'Défaite';
    if (outcome === 'draw') return 'Nul';
    return '';
  }

  private ranking(stat: (s: StandingEntry) => number): StandingEntry[] {
    return (this.tournament?.standings ?? [])
      .filter((s) => s.gamesPlayed > 0)
      .slice()
      .sort((a, b) => stat(b) - stat(a));
  }

  bashlordRanking(): StandingEntry[] {
    return this.ranking((s) => s.casFor);
  }

  aggroLordRanking(): StandingEntry[] {
    return this.ranking((s) => s.aggFor);
  }

  topScorerRanking(): StandingEntry[] {
    return this.ranking((s) => s.tdFor);
  }

  private squadRanking(stat: (s: SquadStandingEntry) => number): SquadStandingEntry[] {
    return (this.tournament?.squadStandings ?? [])
      .filter((s) => s.gamesPlayed > 0)
      .slice()
      .sort((a, b) => stat(b) - stat(a));
  }

  squadBashlordRanking(): SquadStandingEntry[] {
    return this.squadRanking((s) => s.casFor);
  }

  squadAggroLordRanking(): SquadStandingEntry[] {
    return this.squadRanking((s) => s.aggFor);
  }

  squadTopScorerRanking(): SquadStandingEntry[] {
    return this.squadRanking((s) => s.tdFor);
  }

  rankMedal(index: number): string {
    return index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '';
  }

  customStatLeaderboards(): CustomStatLeaderboard[] {
    return this.tournament?.customStatLeaderboards ?? [];
  }

  selectedPool: Pool | null = null;

  openPoolById(poolId: string | null): void {
    if (!poolId) return;
    const pool = this.derived.poolsById.get(poolId);
    if (pool) this.selectedPool = pool;
  }

  closePool(): void {
    this.selectedPool = null;
  }

  /** Closes the pool modal and opens the given member's own team modal on top of it. */
  openTeamFromPool(teamId: string): void {
    this.selectedPool = null;
    this.openTeamById(teamId);
  }

  selectedPoolStandings(): StandingEntry[] {
    if (!this.selectedPool) return [];
    return this.poolStandings(this.selectedPool.id);
  }

  readonly bracketTeamName = (teamId: string) => (this.showTeamNames ? this.teamName(teamId) : this.teamCoach(teamId));
  readonly bracketTeamRace = (teamId: string) => this.teamRace(teamId);
}
