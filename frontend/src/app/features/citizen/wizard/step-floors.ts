import { Component, computed, inject, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  blockBuiltUp,
  blockBuiltUpO,
  blockTotalNbcOccLoad,
  blockTotalNbcOccLoadO,
  blockTotalOccLoad,
  blockTotalOccLoadO,
  floorDisplay,
  t20OccCount,
  t20OccCountO,
} from '../../../core/domain/commonrules';
import { Block } from '../../../core/models';
import { IconComponent } from '../../../shared/ui/icon';
import { ApplicationDraftStore } from './application-draft.store';

/** Block flow, page 2 — the floors table of legacy editpnoc_1.html (area, occupancy, occupants, NBC Table 20). */
@Component({
  selector: 'app-step-floors',
  imports: [FormsModule, IconComponent],
  templateUrl: './step-floors.html',
  styleUrl: './step-blocks.scss',
})
export class StepFloors {
  protected readonly store = inject(ApplicationDraftStore);

  readonly index = input.required<number>();

  protected readonly block = computed<Block | null>(() => {
    this.store.changeCount();
    return this.store.app()?.blocks[this.index()] ?? null;
  });

  protected readonly t20 = t20OccCount;
  protected readonly t20O = t20OccCountO;
  protected readonly blockBuiltUp = blockBuiltUp;
  protected readonly blockBuiltUpO = blockBuiltUpO;
  protected readonly blockTotalOccLoad = blockTotalOccLoad;
  protected readonly blockTotalOccLoadO = blockTotalOccLoadO;
  protected readonly blockTotalNbcOccLoad = blockTotalNbcOccLoad;
  protected readonly blockTotalNbcOccLoadO = blockTotalNbcOccLoadO;
  protected readonly floorDisplay = floorDisplay;

  protected showParent(): boolean {
    const a = this.store.app();
    return !!a && a.appl_type === 'O' && a.parent_id > 0;
  }

  protected err(path: string): string | null {
    return this.store.fieldError(`blocks.${this.index()}.${path}`);
  }
}
