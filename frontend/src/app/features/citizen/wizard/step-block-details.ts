import { Component, computed, inject, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { directionName, frontAbutting, openSpaceMessage, reqdOpenSpace } from '../../../core/domain/commonrules';
import { Block, BuildType } from '../../../core/models';
import { IconComponent } from '../../../shared/ui/icon';
import { ApplicationDraftStore } from './application-draft.store';

/** Block flow, page 1 — legacy editpnoc_1.html: building details, surroundings, open spaces, road widening. */
@Component({
  selector: 'app-step-block-details',
  imports: [FormsModule, IconComponent],
  templateUrl: './step-block-details.html',
  styleUrl: './step-blocks.scss',
})
export class StepBlockDetails {
  protected readonly store = inject(ApplicationDraftStore);

  /** Index of the block in the application. */
  readonly index = input.required<number>();

  protected readonly block = computed<Block | null>(() => {
    this.store.changeCount();
    return this.store.app()?.blocks[this.index()] ?? null;
  });

  protected readonly directionName = directionName;
  protected readonly frontAbutting = frontAbutting;

  protected buildType(code: string): BuildType | undefined {
    return this.store.lookups()?.buildTypes.find((t) => t.code === code);
  }

  protected usesPermissibleHeight(): boolean {
    const a = this.store.app();
    return !!a && (a.appl_type === 'P' || (a.appl_type === 'O' && a.appl_mode !== 'N'));
  }

  /** Occupancy carried forward from a Provisional NOC: show the "as per PNOC" comparison columns. */
  protected showParent(): boolean {
    const a = this.store.app();
    return !!a && a.appl_type === 'O' && a.parent_id > 0;
  }

  protected reqdOs(block: Block, direc: string): number {
    const a = this.store.app()!;
    return reqdOpenSpace(block, direc, a.plot_area, a.appl_type, a.appl_mode);
  }

  protected osMessage(reqd: number): string | null {
    return openSpaceMessage(reqd);
  }

  protected err(path: string): string | null {
    return this.store.fieldError(`blocks.${this.index()}.${path}`);
  }

  protected onTypeChange(block: Block, code: string): void {
    block.site_type = code;
    block.site_stype = '';
    this.store.touch();
  }
}
