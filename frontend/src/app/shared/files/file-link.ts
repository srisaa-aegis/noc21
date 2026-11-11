import { Component, inject, input } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { CitizenApi } from '../../core/api/citizen-api.service';
import { ToastService } from '../ui/toast.service';

/**
 * Name of an uploaded file; when it is stored on the server (`fileId`), a link
 * that opens it in a new tab through a one-time download token (the bearer
 * token never appears in a URL). Files of the offline demo have no `fileId`
 * and render as plain text.
 */
@Component({
  selector: 'app-file-link',
  template: `
    @if (fileId()) {
      <a href="#" class="file-link" (click)="open($event)" [attr.title]="'Open ' + name()">{{ name() }}</a>
    } @else {
      {{ name() }}
    }
  `,
  styles: `.file-link { text-decoration: underline; cursor: pointer; }`,
})
export class FileLink {
  readonly fileId = input<string | undefined>(undefined);
  readonly name = input.required<string>();
  private readonly api = inject(CitizenApi);
  private readonly toast = inject(ToastService);

  protected async open(event: Event): Promise<void> {
    event.preventDefault();
    const id = this.fileId();
    if (!id) return;
    // Open the tab synchronously (popup blockers), then point it at the one-time URL.
    const tab = window.open('', '_blank');
    try {
      const url = await firstValueFrom(this.api.downloadUrl(id));
      if (tab) tab.location.href = url;
      else window.location.href = url;
    } catch (e) {
      tab?.close();
      this.toast.error((e as Error).message || 'The file could not be opened.');
    }
  }
}
