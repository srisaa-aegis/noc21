import { Component, computed } from '@angular/core';
import { CertificateBase } from './certificate-base';

/** Short-form framed certificate for display at the premises — legacy modules/dept/partials/OccCert.html. */
@Component({
  selector: 'app-occupancy-certificate',
  template: `
    @let a = app();
    <div class="occ-cert">
      <div class="occ-cert__emblem" aria-hidden="true">🔥</div>
      <p class="occ-cert__gov">Government of Andhra Pradesh</p>
      <p class="occ-cert__dept">A.P. State Disaster Response and Fire Services Department</p>
      <p class="occ-cert__title">{{ a.appl_type === 'P' ? 'Provisional' : 'Occupancy' }} No Objection Certificate</p>
      <div class="occ-cert__meta">
        <span>Ref No: {{ a.appl_number }}</span>
        <span>Date : {{ a.final_date }}</span>
      </div>
      @if (firstBlock(); as b) {
        <p class="occ-cert__body">
          Certified that <b class="big">{{ a.site_name }}</b>, {{ a.site_addr }}, with {{ fn.floorDisplay(b) }} owned by <b class="big">{{ a.build_name }}</b>, has
          complied fire prevention and safety measures as per Rule(15) under Provision of AP Fire services Act 1999 and AP Fire and Emergancy operations and Levy of
          Fee Rules, 2006 under class <b class="big">{{ typeName(b.site_type) }} ({{ subTypeName(b.site_type, b.site_stype) }})</b>.
          @if (a.valid_to) { This occupancy NOC is valid upto {{ letterDate(a.valid_to) }}. }
        </p>
      }
      <div class="occ-cert__foot">
        <div>Issued On: {{ a.final_date }}<div class="barcode">*{{ a.appl_number }}*</div></div>
        <div class="occ-cert__sign">@for (l of signLines(); track $index) { <div>{{ l }}</div> }</div>
      </div>
    </div>
  `,
  styleUrl: './certificate.scss',
  styles: `
    .occ-cert { border: 6px double #b91c1c; padding: 28px 36px; font-size: 17px; }
    .occ-cert__emblem { text-align: center; font-size: 40px; }
    .occ-cert__gov, .occ-cert__dept, .occ-cert__title { text-align: center; color: #c00; font-weight: 700; margin: 2px 0; }
    .occ-cert__gov { font-size: 20px; }
    .occ-cert__title { text-decoration: underline; margin-top: 10px; }
    .occ-cert__meta { display: flex; justify-content: space-between; margin: 18px 0; }
    .occ-cert__body { text-align: justify; margin: 24px 0; line-height: 1.7; }
    .big { font-size: 20px; }
    .occ-cert__foot { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 24px; }
    .occ-cert__sign { text-align: center; }
    .barcode { margin-top: 6px; }
  `,
})
export class OccupancyCertificate extends CertificateBase {
  protected readonly signLines = computed(() => this.signatory(this.app().appl_type === 'R' || this.app().appl_type === 'RO' ? 'R' : 'O'));
}
