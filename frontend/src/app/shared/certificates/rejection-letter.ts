import { Component, computed } from '@angular/core';
import { fromLines } from '../../core/domain/certificate';
import { CertificateBase } from './certificate-base';
import { LetterSignature } from './letter-signature';

const KIND_TEXT: Record<string, string> = { P: 'Provisional', O: 'Occupancy', R: 'Annual Periodical Renewal', RO: 'Annual Periodical Renewal', D: '' };

/** Rejection / return letter — legacy modules/dept/partials/rejection.html. */
@Component({
  selector: 'app-rejection-letter',
  imports: [LetterSignature],
  templateUrl: './rejection-letter.html',
  styleUrl: './certificate.scss',
})
export class RejectionLetter extends CertificateBase {
  protected readonly approverRole = computed(() => this.decision()?.role ?? 'DG');
  protected readonly from = computed(() => fromLines('REJECTION', this.app().delegation_level, this.districtName(), this.approverRole()));
  protected readonly kindText = computed(() => KIND_TEXT[this.app().appl_type] ?? '');
  protected readonly statusText = computed(() => (this.app().status_id === 9 ? 'Rejected' : 'Returned'));
  protected readonly date = computed(() => this.letterDate(this.app().final_date || this.decision()?.at_date));
}
