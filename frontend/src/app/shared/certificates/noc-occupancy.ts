import { Component, computed } from '@angular/core';
import { FfeGrid } from '../ffe/ffe-grid';
import { CertificateBase } from './certificate-base';
import { LetterSignature } from './letter-signature';

/** No Objection Certificate for Occupancy — legacy modules/dept/partials/final_noc_o.html. */
@Component({
  selector: 'app-noc-occupancy',
  imports: [FfeGrid, LetterSignature],
  templateUrl: './noc-occupancy.html',
  styleUrl: './certificate.scss',
})
export class NocOccupancy extends CertificateBase {
  /** Applied without a Provisional NOC (mode N): requirements are shown instead of the PNOC figures. */
  protected readonly withoutPnoc = computed(() => this.app().appl_mode === 'N');
  protected readonly escapeRows = [
    { code: 'I', name: 'Internal Staircases' },
    { code: 'E', name: 'External Staircases' },
  ];
}
