import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  DEFAULT_MATCH_SHEET_CONFIG,
  type CustomStatCategoryConfig,
  type MatchResult,
  type MatchSheetConfig,
  type SubmitResultRequest,
} from '@bb-tournament/shared';

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

@Component({
  selector: 'app-match-result-form',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './match-result-form.component.html',
  styleUrl: './match-result-form.component.scss',
})
export class MatchResultFormComponent implements OnChanges {
  @Input({ required: true }) team1Id!: string;
  @Input({ required: true }) team2Id!: string;
  @Input({ required: true }) team1Name!: string;
  @Input({ required: true }) team2Name!: string;
  @Input() submitLabel = 'Envoyer le résultat';
  @Input() initial: MatchResult | null = null;
  @Input() busy = false;
  @Input() matchSheetConfig: MatchSheetConfig = DEFAULT_MATCH_SHEET_CONFIG;
  @Input() customStatCategories: CustomStatCategoryConfig[] = [];

  @Output() submitResult = new EventEmitter<SubmitResultRequest>();

  playedAt = todayIsoDate();
  team1Td = 0;
  team2Td = 0;
  team1Cas = 0;
  team2Cas = 0;
  team1Agg = 0;
  team2Agg = 0;
  customStats: Record<string, { team1: number; team2: number }> = {};

  get enabledCustomStatCategories(): CustomStatCategoryConfig[] {
    return this.customStatCategories.filter((c) => c.enabled);
  }

  ngOnChanges(): void {
    for (const category of this.enabledCustomStatCategories) {
      if (!this.customStats[category.id]) this.customStats[category.id] = { team1: 0, team2: 0 };
    }

    if (this.initial) {
      this.playedAt = this.initial.playedAt;
      this.team1Td = this.initial.team1Td;
      this.team2Td = this.initial.team2Td;
      this.team1Cas = this.initial.team1Cas;
      this.team2Cas = this.initial.team2Cas;
      this.team1Agg = this.initial.team1Agg;
      this.team2Agg = this.initial.team2Agg;
      for (const category of this.enabledCustomStatCategories) {
        const value = this.initial.customStats?.[category.id];
        this.customStats[category.id] = { team1: value?.team1 ?? 0, team2: value?.team2 ?? 0 };
      }
    }
  }

  submit(): void {
    const customStats: Record<string, { team1: number; team2: number }> = {};
    for (const category of this.enabledCustomStatCategories) {
      const value = this.customStats[category.id] ?? { team1: 0, team2: 0 };
      customStats[category.id] = { team1: value.team1, team2: value.team2 };
    }
    this.submitResult.emit({
      playedAt: this.playedAt,
      team1Td: this.team1Td,
      team2Td: this.team2Td,
      team1Cas: this.team1Cas,
      team2Cas: this.team2Cas,
      team1Agg: this.team1Agg,
      team2Agg: this.team2Agg,
      customStats,
      concededByTeamId: null,
    });
  }
}
