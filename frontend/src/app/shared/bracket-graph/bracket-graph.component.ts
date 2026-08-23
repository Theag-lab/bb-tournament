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
  x1: number;
  y1: number;
  x2: number;
  y2: number;
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

  get connectors(): ConnectorView[] {
    const columns = this.columns;
    const lines: ConnectorView[] = [];
    for (let r = 1; r < columns.length; r++) {
      const parent = columns[r - 1];
      const child = columns[r];
      child.slots.forEach((slot, i) => {
        const a = parent.slots[2 * i];
        const b = parent.slots[2 * i + 1];
        if (a) lines.push({ x1: parent.x + this.cardWidth, y1: a.y, x2: slot.x, y2: slot.y });
        if (b) lines.push({ x1: parent.x + this.cardWidth, y1: b.y, x2: slot.x, y2: slot.y });
      });
    }
    return lines;
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
    return { x1: last.x + this.cardWidth, y1: last.slots[0].y, x2: champion.x, y2: champion.y };
  }

  get svgWidth(): number {
    const columnCount = this.columns.length + (this.champion ? 1 : 0);
    return Math.max(columnCount * ROUND_GAP_X, ROUND_GAP_X) + 2 * MARGIN;
  }

  get svgHeight(): number {
    const firstColumnSlots = this.columns[0]?.slots.length ?? 1;
    return Math.max(firstColumnSlots * SLOT_UNIT_Y, SLOT_UNIT_Y) + 2 * MARGIN;
  }
}
