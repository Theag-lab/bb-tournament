import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';
import type { BracketRoundView } from '@bb-tournament/shared';

interface SlotView {
  x: number;
  y: number;
  isBye: boolean;
  team1Id: string;
  team2Id: string | null; // null for a bye
  winnerTeamId: string | null;
}

interface ConnectorView {
  d: string;
}

interface ChampionView {
  x: number;
  y: number;
  teamId: string;
}

const CARD_W = 200;
const CARD_H = 60;
const ROUND_GAP_X = 260;
const SLOT_UNIT_Y = 88;
const MARGIN = 24;
const HEADER_H = 34;

// Indexed by "columns still to come after this one" (0 = this column is the final).
const ROUND_NAMES_FROM_FINAL = [
  'Finale',
  'Demi-finale',
  'Quart de finale',
  'Huitième de finale',
  'Seizième de finale',
  'Trente-deuxième de finale',
];

/**
 * Read-only elimination-bracket graph: one column per knockout round already generated (rounds
 * not yet generated simply aren't in `rounds`, which is what makes the graph fill in
 * progressively). Each round's existence implies the previous one is fully complete, so every
 * inter-round connector is drawn as settled history — only the latest round's own match cards may
 * still be undecided (no winner highlighted yet, no outgoing connector).
 */
@Component({
  selector: 'app-bracket-graph',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './bracket-graph.component.html',
  styleUrl: './bracket-graph.component.scss',
})
export class BracketGraphComponent {
  @Input({ required: true }) rounds: BracketRoundView[] = [];
  @Input({ required: true }) teamName!: (teamId: string) => string;
  @Input({ required: true }) teamRace!: (teamId: string) => string;

  readonly cardWidth = CARD_W;
  readonly cardHeight = CARD_H;
  readonly headerHeight = HEADER_H;

  get columns(): { x: number; slots: SlotView[] }[] {
    const columns: { x: number; slots: SlotView[] }[] = [];
    let previousY: number[] = [];

    this.rounds.forEach((round, r) => {
      const ordered = [
        ...round.byes.map((b) => ({ position: b.position, isBye: true, byeTeamId: b.teamId, match: null as null | typeof round.matches[number] })),
        ...round.matches.map((m) => ({ position: m.position, isBye: false, byeTeamId: null, match: m })),
      ].sort((a, b) => a.position - b.position);

      const y: number[] = ordered.map((_, i) =>
        r === 0 ? i * SLOT_UNIT_Y + SLOT_UNIT_Y / 2 : (previousY[2 * i] + previousY[2 * i + 1]) / 2
      );

      const slots: SlotView[] = ordered.map((entry, i) => ({
        x: r * ROUND_GAP_X,
        y: y[i],
        isBye: entry.isBye,
        team1Id: entry.isBye ? entry.byeTeamId! : entry.match!.team1Id,
        team2Id: entry.isBye ? null : entry.match!.team2Id,
        winnerTeamId: entry.isBye ? entry.byeTeamId! : entry.match!.winnerTeamId,
      }));

      columns.push({ x: r * ROUND_GAP_X, slots });
      previousY = y;
    });

    return columns;
  }

  /**
   * Total number of knockout rounds implied by the bracket size — fixed for the whole knockout
   * phase, unlike `rounds.length` (which only counts rounds generated *so far* and would
   * otherwise make every earlier round's label shift as later rounds get generated). Derived from
   * the first knockout round (always `rounds[0]`, the only one with byes): byes advance one team
   * each, matches two, so `byes + 2*matches` is the full bracket size, a power of two.
   */
  private get totalKnockoutRounds(): number {
    const first = this.rounds[0];
    if (!first) return 0;
    const bracketSize = first.byes.length + first.matches.length * 2;
    return Math.round(Math.log2(bracketSize));
  }

  /** One label per column, named by distance from the final (last column = "Finale", etc). */
  get roundLabels(): string[] {
    const total = this.totalKnockoutRounds;
    return this.rounds.map((round, i) => {
      const distanceFromFinal = total - 1 - i;
      return ROUND_NAMES_FROM_FINAL[distanceFromFinal] ?? `Ronde ${round.roundNumber}`;
    });
  }

  get connectors(): ConnectorView[] {
    const columns = this.columns;
    const lines: ConnectorView[] = [];
    for (let r = 1; r < columns.length; r++) {
      const parent = columns[r - 1];
      const child = columns[r];
      child.slots.forEach((slot, i) => {
        const a = parent.slots[2 * i];
        const b = parent.slots[2 * i + 1];
        if (a) lines.push({ d: this.elbowPath(parent.x + this.cardWidth, a.y, slot.x, slot.y) });
        if (b) lines.push({ d: this.elbowPath(parent.x + this.cardWidth, b.y, slot.x, slot.y) });
      });
    }
    return lines;
  }

  private elbowPath(x1: number, y1: number, x2: number, y2: number): string {
    const midX = x1 + (x2 - x1) / 2;
    const r = 8;
    if (y1 === y2) return `M ${x1} ${y1} H ${x2}`;
    const dir = y2 > y1 ? 1 : -1;
    return [
      `M ${x1} ${y1}`,
      `H ${midX - r}`,
      `Q ${midX} ${y1} ${midX} ${y1 + r * dir}`,
      `V ${y2 - r * dir}`,
      `Q ${midX} ${y2} ${midX + r} ${y2}`,
      `H ${x2}`,
    ].join(' ');
  }

  get champion(): ChampionView | null {
    const columns = this.columns;
    if (columns.length === 0) return null;
    const last = columns[columns.length - 1];
    if (last.slots.length !== 1) return null;
    const slot = last.slots[0];
    if (!slot.winnerTeamId) return null;
    return { x: last.x + ROUND_GAP_X, y: slot.y, teamId: slot.winnerTeamId };
  }

  get championConnector(): ConnectorView | null {
    const champion = this.champion;
    const columns = this.columns;
    if (!champion || columns.length === 0) return null;
    const last = columns[columns.length - 1];
    return { d: this.elbowPath(last.x + this.cardWidth, last.slots[0].y, champion.x, champion.y) };
  }

  get svgWidth(): number {
    const columnCount = this.columns.length + (this.champion ? 1 : 0);
    return Math.max(columnCount * ROUND_GAP_X, ROUND_GAP_X) + 2 * MARGIN;
  }

  get svgHeight(): number {
    const firstColumnSlots = this.columns[0]?.slots.length ?? 1;
    return Math.max(firstColumnSlots * SLOT_UNIT_Y, SLOT_UNIT_Y) + 2 * MARGIN + this.headerHeight;
  }

  /** Row-level outcome, used to tint each half of a card the instant its match is decided. */
  rowState(slot: SlotView, teamId: string | null): 'winner' | 'loser' | 'pending' {
    if (!teamId || !slot.winnerTeamId) return 'pending';
    return slot.winnerTeamId === teamId ? 'winner' : 'loser';
  }
}
