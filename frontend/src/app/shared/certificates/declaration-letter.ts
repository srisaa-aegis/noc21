import { Component } from '@angular/core';
import { CertificateBase } from './certificate-base';
import { LetterSignature } from './letter-signature';

/**
 * Acceptance of the Self-Declaration for Renewal — legacy `dgfs_note` outcome for Declarations (no
 * dedicated legacy print template; the decision form showed the same text inline). Used by the
 * citizen print page and by the department's live decision preview (Phase 3b).
 */
@Component({
  selector: 'app-declaration-letter',
  imports: [LetterSignature],
  templateUrl: './declaration-letter.html',
  styleUrl: './certificate.scss',
})
export class DeclarationLetter extends CertificateBase {}
