import { Component, computed, inject, input, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ffeColumns } from '../../../core/domain/ffe';
import { LookupService } from '../../../core/lookups/lookup.service';
import { ApplTypeFfeColumn, Block, Equipment } from '../../../core/models';
import { FfeGrid } from '../../../shared/ffe/ffe-grid';
import { IconComponent } from '../../../shared/ui/icon';
import { Modal } from '../../../shared/ui/modal';
import { ApplicationDraftStore } from './application-draft.store';

/**
 * Block flow, page 4: Fire Fighting Equipment — legacy editpnoc_3 (Provisional), editonoc_3 (Occupancy), editronoc_3 (Renewal).
 * Requirements are calculated from the verbatim rule trees (uploads/rules/{equipment}.rule) on every change.
 */
@Component({
  selector: 'app-step-ffe',
  imports: [FormsModule, IconComponent, FfeGrid, Modal],
  templateUrl: './step-ffe.html',
  styleUrl: './step-ffe.scss',
})
export class StepFfe {
  protected readonly store = inject(ApplicationDraftStore);
  private readonly lookupService = inject(LookupService);

  /** Index of the block in the application. */
  readonly index = input.required<number>();
  protected readonly block = computed<Block | null>(() => {
    this.store.changeCount();
    return this.store.app()?.blocks[this.index()] ?? null;
  });

  protected readonly table7 = toSignal(this.lookupService.nbcTable7$);
  protected readonly showTable7 = signal(false);

  /** Columns driven by ApplTypes.txt `mode[].ffe[]` for this application's type and mode. */
  protected readonly columns = computed<ApplTypeFfeColumn[]>(() => {
    this.store.changeCount();
    const a = this.store.app();
    const l = this.store.lookups();
    return a && l ? ffeColumns(l.applicationTypes, a.appl_type, a.appl_mode) : [];
  });

  protected readonly hasInputs = computed(() => this.columns().some((c) => c.type === 'input'));

  /** "I confirm that the construction shall adhere to the minimum quantities…" — Provisional and Occupancy without PNOC. */
  protected readonly needsConfirmation = computed(() => {
    this.store.changeCount();
    const a = this.store.app();
    return !!a && (a.appl_type === 'P' || (a.appl_type === 'O' && a.appl_mode === 'N'));
  });

  protected readonly blockErrors = computed(() => this.store.blockErrorsFor(this.index(), 'ffe'));

  protected readonly blockWarnings = computed(() => this.store.blockWarningsFor(this.index(), 'ffe'));

  // Legacy "Add Fire Fighting Equipment" dialog
  protected readonly adding = signal(false);
  protected picked: Record<number, boolean> = {};

  protected addable(block: Block): Equipment[] {
    const have = new Set(block.ffe.items.map((i) => i.equip_id));
    return (this.store.lookups()?.equipments ?? []).filter((e) => !have.has(e.id));
  }

  protected openAdd(): void {
    this.picked = {};
    this.adding.set(true);
  }

  protected confirmAdd(block: Block): void {
    for (const [id, on] of Object.entries(this.picked)) {
      if (on) this.store.addEquipment(block, Number(id));
    }
    this.adding.set(false);
  }

  protected setAgree(block: Block, value: boolean): void {
    this.store.set(block.ffe, 'agree_reqt', value);
  }
}
