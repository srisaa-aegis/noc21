import { Component, computed, inject, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  aggregateStaircase,
  directionName,
  doorWidthRequired,
  fireLiftsReqd,
  floorEscapeWidth,
  floorOccuName,
  floorTypeName,
  maxDeadEndDistance,
  maxOccuCount,
  maxStairsByLoad,
  maxTravelDistance,
  proposedEscapeCount,
  refugeAreaRequired,
  reqdEscapeCount,
  reqdEscapeWidth,
  stairsByLoad,
  t20OccCount,
  totalStairsRequiredByNBC,
} from '../../../core/domain/commonrules';
import { Block } from '../../../core/models';
import { IconComponent } from '../../../shared/ui/icon';
import { ApplicationDraftStore } from './application-draft.store';

/** Block flow, page 3: Means of Escape — legacy editpnoc_2.html (staircases, travel distance, doors, exits, refuge, fire lifts, parking). */
@Component({
  selector: 'app-step-escapes',
  imports: [FormsModule, IconComponent],
  templateUrl: './step-escapes.html',
  styleUrl: './step-blocks.scss',
})
export class StepEscapes {
  protected readonly store = inject(ApplicationDraftStore);

  /** Index of the block in the application. */
  readonly index = input.required<number>();
  protected readonly block = computed<Block | null>(() => {
    this.store.changeCount();
    return this.store.app()?.blocks[this.index()] ?? null;
  });

  protected readonly fn = {
    aggregateStaircase,
    directionName,
    doorWidthRequired,
    fireLiftsReqd,
    floorEscapeWidth,
    floorOccuName,
    floorTypeName,
    maxStairsByLoad,
    proposedEscapeCount,
    reqdEscapeCount,
    stairsByLoad,
    t20OccCount,
    totalStairsRequiredByNBC,
  };

  protected err(path: string): string | null {
    return this.store.fieldError(`blocks.${this.index()}.${path}`);
  }

  protected minWidth(block: Block, etype: string): string {
    return reqdEscapeWidth(etype, block.site_type, block.site_stype, maxOccuCount(block));
  }

  private sprinklered(block: Block): boolean {
    return block.ffe?.items.some((i) => i.equip_id === 5) ?? false;
  }

  protected maxTd(block: Block): number {
    return maxTravelDistance(block, this.store.lookups()!.escapeRules, this.sprinklered(block));
  }

  protected maxDe(block: Block): number {
    return maxDeadEndDistance(block, this.store.lookups()!.escapeRules, this.sprinklered(block));
  }

  protected refugeReqd(block: Block, floorId: number): number {
    const r = this.store.lookups()!.escapeRules;
    return refugeAreaRequired(block, floorId, r.refuge_area_per_person, r.refuge_min_area);
  }

  protected refugeNeeded(block: Block): boolean {
    return Number(block.height) > this.store.lookups()!.escapeRules.refuge_min_height;
  }

  protected num(v: unknown): number {
    return Number(v) || 0;
  }
}
