import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';
import {
  DEFAULT_MATCH_SHEET_CONFIG,
  type CustomStatCategoryConfig,
  type MatchResult,
  type MatchSheetConfig,
} from '@bb-tournament/shared';

interface SummaryRow {
  label: string;
  team1: number;
  team2: number;
}

/**
 * Read-only recap of every stat on a submitted match sheet (TD, sorties, agressions, custom
 * counters), one column per side — so the confirming coach checks the whole sheet, not just the TD.
 */
@Component({
  selector: 'app-match-result-summary',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './match-result-summary.component.html',
  styleUrl: './match-result-summary.component.scss',
})
export class MatchResultSummaryComponent {
  @Input({ required: true }) result!: MatchResult;
  @Input({ required: true }) team1Name!: string;
  @Input({ required: true }) team2Name!: string;
  @Input() matchSheetConfig: MatchSheetConfig = DEFAULT_MATCH_SHEET_CONFIG;
  @Input() customStatCategories: CustomStatCategoryConfig[] = [];

  get rows(): SummaryRow[] {
    const r = this.result;
    const rows: SummaryRow[] = [{ label: 'Touchdowns', team1: r.team1Td, team2: r.team2Td }];
    if (this.matchSheetConfig.cas.enabled) rows.push({ label: 'Sorties', team1: r.team1Cas, team2: r.team2Cas });
    if (this.matchSheetConfig.agg.enabled) rows.push({ label: 'Agressions', team1: r.team1Agg, team2: r.team2Agg });
    for (const category of this.customStatCategories) {
      if (!category.enabled) continue;
      const value = r.customStats?.[category.id];
      rows.push({ label: category.name, team1: value?.team1 ?? 0, team2: value?.team2 ?? 0 });
    }
    return rows;
  }
}
