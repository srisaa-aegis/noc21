import { Component, input } from '@angular/core';

/** "Yours Sincerely" block with the signatory, the file-number barcode placeholder and the "Copy to" list. */
@Component({
  selector: 'app-letter-signature',
  template: `
    <div class="sign-row">
      <div class="barcode" [attr.aria-label]="'File number ' + fileNo()">*{{ fileNo() }}*</div>
      <div class="signature">
        Yours Sincerely,
        <div class="signature__space"></div>
        @for (l of lines(); track $index) {
          <div>{{ l }}</div>
        }
      </div>
    </div>
    @if (copyTo().length) {
      <div class="copy-to">
        @for (c of copyTo(); track $index) {
          <div>Copy to {{ c }}</div>
        }
      </div>
    }
  `,
  styleUrl: './certificate.scss',
})
export class LetterSignature {
  readonly fileNo = input('');
  readonly lines = input<string[]>([]);
  readonly copyTo = input<string[]>([]);
}
