import { Component, computed } from '@angular/core';
import { fromLines, renewalPeriodLabel } from '../../core/domain/certificate';
import { CertificateBase } from './certificate-base';
import { LetterSignature } from './letter-signature';

/** Annual Periodical Renewal Fire Certificate — legacy modules/dept/partials/final_noc_r.html. */
@Component({
  selector: 'app-noc-renewal',
  imports: [LetterSignature],
  templateUrl: './noc-renewal.html',
  styleUrl: './certificate.scss',
})
export class NocRenewal extends CertificateBase {
  protected readonly from = computed(() => fromLines('R', this.app().delegation_level, this.districtName()));
  protected readonly period = computed(() => renewalPeriodLabel(this.app().valid_from, this.app().valid_to));
  /** Occupancy NOC date (legacy oc_date) — the parent Occupancy NOC, when carried forward online. */
  protected readonly ocDate = computed(() => {
    const p = this.parent();
    return p?.appl_type === 'O' ? this.letterDate(p.final_date) : '';
  });
  /** Previous renewal (legacy last_renewal_date) — when this renewal was carried forward from an earlier renewal. */
  protected readonly lastRenewalDate = computed(() => {
    const p = this.parent();
    return p && (p.appl_type === 'R' || p.appl_type === 'RO') ? this.letterDate(p.final_date) : '';
  });
  protected readonly paymentText = computed(() => {
    const pay = this.app().payment;
    return pay.mode === 'challan'
      ? `vide challan No. ${pay.challan_num}, Dated ${pay.challan_date} at ${pay.challan_bnk}, ${pay.challan_brch}`
      : `vide online payment transaction ${pay.txn_ref ?? ''}, Dated ${pay.paid_on ?? ''}`;
  });
}
