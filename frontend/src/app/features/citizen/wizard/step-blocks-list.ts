import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { blockDelegationLevel, delegationLevelName } from '../../../core/domain/application-rules';
import { blockBuiltUp, floorDisplay } from '../../../core/domain/commonrules';
import { BLOCK_STEPS, BlockStepId, WizardTarget } from '../../../core/domain/wizard-steps';
import { Block } from '../../../core/models';
import { ConfirmDialogService } from '../../../shared/ui/confirm-dialog.service';
import { IconComponent } from '../../../shared/ui/icon';
import { Modal } from '../../../shared/ui/modal';
import { ApplicationDraftStore } from './application-draft.store';

/**
 * Blocks — legacy editpnoc.html block table: one row per building with its summary and the buttons
 * that open the block's own flow (Block Details → Floors → Means of Escape → Fire Fighting Equipment → Plans).
 */
@Component({
  selector: 'app-step-blocks-list',
  imports: [FormsModule, IconComponent, Modal, DecimalPipe],
  templateUrl: './step-blocks-list.html',
  styleUrl: './step-blocks-list.scss',
})
export class StepBlocksList {
  protected readonly store = inject(ApplicationDraftStore);
  private readonly dialog = inject(ConfirmDialogService);

  /** Open a page of a block's flow. */
  readonly open = output<WizardTarget>();

  protected readonly pages = BLOCK_STEPS;
  protected readonly floorDisplay = floorDisplay;
  protected readonly blockBuiltUp = blockBuiltUp;

  protected readonly blocks = computed<Block[]>(() => {
    this.store.changeCount();
    return this.store.app()?.blocks ?? [];
  });

  // Add Block dialog (legacy #addblock: Normal Block, or Tower and Podium Block)
  protected readonly adding = signal(false);
  protected newBlockType: 'N' | 'T' = 'N';
  protected newBlockName = '';
  protected newTowerName = '';
  protected newPodiumName = '';

  protected typeName(code: string): string {
    return this.store.lookups()?.buildTypes.find((t) => t.code === code)?.name ?? '—';
  }

  protected levelName(block: Block): string {
    const rules = this.store.lookups()?.delegationRules ?? [];
    return block.site_type && block.height ? delegationLevelName(blockDelegationLevel(block, rules)) : '—';
  }

  protected count(index: number, page?: BlockStepId): number {
    return this.store.blockErrorsFor(index, page).length;
  }

  /** First page of the block that still has problems (or its first page). */
  protected firstOpenPage(index: number): BlockStepId {
    return this.pages.find((p) => this.count(index, p.id) > 0)?.id ?? 'details';
  }

  protected go(block: Block, page: BlockStepId): void {
    this.open.emit({ step: 'blocks', blockId: block.block_id, blockStep: page });
  }

  protected openAdd(): void {
    this.newBlockType = 'N';
    this.newBlockName = '';
    this.newTowerName = '';
    this.newPodiumName = '';
    this.adding.set(true);
  }

  protected confirmAdd(): void {
    let index: number;
    if (this.newBlockType === 'N') {
      index = this.store.addBlock('N', this.newBlockName.trim() || undefined);
    } else {
      index = this.store.addBlock('T', this.newTowerName.trim() || 'Tower');
      this.store.addBlock('P', this.newPodiumName.trim() || 'Podium');
    }
    this.adding.set(false);
    this.go(this.store.app()!.blocks[index], 'details');
  }

  protected async removeBlock(i: number): Promise<void> {
    const b = this.store.app()!.blocks[i];
    const ok = await this.dialog.open({
      title: 'Delete block?',
      message: `"${b.block_name || 'This block'}" with its floors, escapes, equipment and uploaded plans will be removed from the application.`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
    });
    if (ok) this.store.removeBlock(i);
  }
}
