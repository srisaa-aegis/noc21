import { Component, computed } from '@angular/core';
import { isRevisedProvisional } from '../../core/domain/certificate';
import { FfeGrid } from '../ffe/ffe-grid';
import { CertificateBase } from './certificate-base';
import { LetterSignature } from './letter-signature';

/** Provisional Fire No Objection Certificate — legacy modules/dept/partials/final_noc_16.html (NBC 2016 format). */
@Component({
  selector: 'app-noc-provisional',
  imports: [FfeGrid, LetterSignature],
  templateUrl: './noc-provisional.html',
  styleUrl: './certificate.scss',
})
export class NocProvisional extends CertificateBase {
  protected readonly revised = computed(() => isRevisedProvisional(this.app()));
  protected readonly escapeRows = [
    { code: 'I', name: 'Internal Staircases' },
    { code: 'E', name: 'External Staircases' },
    { code: 'R', name: 'Ramp (above Ground)' },
    { code: 'C', name: 'Basement Ramp' },
  ];
}
