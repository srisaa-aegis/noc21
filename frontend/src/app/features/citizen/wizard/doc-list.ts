import { DecimalPipe } from '@angular/common';
import { Component, inject, input } from '@angular/core';
import { RequiredDocument } from '../../../core/domain/documents';
import { FileLink } from '../../../shared/files/file-link';
import { IconComponent } from '../../../shared/ui/icon';
import { ToastService } from '../../../shared/ui/toast.service';
import { ApplicationDraftStore } from './application-draft.store';

/** Upload list for a set of required documents / plans (PDF only; stored on the server when the backend is used). */
@Component({
  selector: 'app-doc-list',
  imports: [IconComponent, DecimalPipe, FileLink],
  templateUrl: './doc-list.html',
  styleUrl: './step-documents.scss',
})
export class DocList {
  protected readonly store = inject(ApplicationDraftStore);
  private readonly toast = inject(ToastService);

  readonly docs = input.required<RequiredDocument[]>();

  protected async onFile(doc: RequiredDocument, event: Event): Promise<void> {
    const el = event.target as HTMLInputElement;
    const file = el.files?.[0];
    el.value = '';
    if (!file) return;
    const problem = await this.store.attachDocument(doc, file);
    if (problem) this.toast.error(`${doc.label}: ${problem}`);
    else this.toast.success(`${doc.label} attached.`);
  }

  protected remove(doc: RequiredDocument): Promise<void> {
    return this.store.removeDocument(doc.code);
  }
}
