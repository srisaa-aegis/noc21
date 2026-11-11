import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideFixtureBackend } from '../../../../testing/fixture-backend';
import { resetBrowserState, seedSession } from '../../../../testing/session';
import { PrintDocument } from './print-document';

describe('PrintDocument', () => {
  beforeEach(async () => {
    resetBrowserState();
    seedSession('citizen1', 'citizen');
    await TestBed.configureTestingModule({
      imports: [PrintDocument],
      providers: [provideRouter([]), provideFixtureBackend()],
    }).compileComponents();
  });

  afterEach(() => resetBrowserState());

  async function open(id: string, doc: string) {
    const fixture = TestBed.createComponent(PrintDocument);
    fixture.componentRef.setInput('id', id);
    fixture.componentRef.setInput('doc', doc);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  it('renders the acknowledgement for a submitted application', async () => {
    const text = await open('102', 'acknowledgement');
    expect(text).toContain('Acknowledgement');
    expect(text).toContain('2017030007');
  });

  it('renders the Provisional NOC in the legacy final_noc_16 format (MSB, signed by the DG)', async () => {
    const text = await open('101', 'certificate');
    expect(text).toContain('Provisional Fire No Objection Certificate');
    expect(text).toContain('Commissioner, Greater Visakhapatnam Municipal Corporation');
    expect(text).toContain('File No: 2016080001');
    expect(text).toContain('Date: 28/09/2016');
    expect(text).toContain('Proposed Construction of Multi Storeyed Building');
    expect(text).toContain('Online Inspection Report submitted by Officers of this Department on 20-Aug-2016');
    expect(text).toContain('Setbacks for the High-rise buildings');
    expect(text).toContain('Open Space Required as per GO.Ms.No.119(APBR , 2017) of MA & UD Dept');
    expect(text).toContain('Basement + Stilt + 7 Upper Floors');
    expect(text).toContain('Internal Staircases');
    expect(text).toContain('Occupant Load as per unit Exit width');
    expect(text).toContain('Table 7 of Part 4 of National Building Code of India 2016');
    expect(text).toContain('Fire Extinguishers');
    expect(text).toContain('The permission accorded does not confer any ownership rights');
    expect(text).not.toContain('Emergency Action Plan'); // condition only for buildings above 60 m
    expect(text).toContain('Provide signage and emergency lighting for the refuge areas');
    expect(text).toContain('should not be occupied');
    expect(text).toContain('Prisons and Correctional Services');
    expect(text).toContain('Copy to Chief Office for Record Purpose');
  });

  it('renders the Occupancy NOC (final_noc_o) for a Non-MSB building signed by the RFO', async () => {
    const text = await open('111', 'certificate');
    expect(text).toContain('No Objection Certificate for Occupancy');
    expect(text).toContain('Open Space Required as per 119 APBR 2016');
    expect(text).toContain('Non MSB');
    expect(text).toContain('The No Objection Certificate for Occupancy is issued subject to the following conditions');
    expect(text).toContain('Regional Fire Officer');
    expect(text).toContain('Copy to Station Fire Officer concerned');
  });

  it('renders the Annual Periodical Renewal Fire Certificate (final_noc_r) with its validity', async () => {
    const text = await open('114', 'certificate');
    expect(text).toContain('Annual Periodical Renewal Fire Certificate');
    expect(text).toContain('Occupancy NoC RC Number: 2019060023');
    expect(text).toContain('This Office NOC for Occupancy Rc No. 2019060023, Dt.30/07/2019');
    expect(text).toContain('for period 2022-2025');
    expect(text).toContain('valid from 28/07/2022 to 27/07/2025');
    expect(text).toContain('Replace the expired fire extinguishers');
  });

  it('renders the short display certificate (OccCert) for an Occupancy NOC', async () => {
    const text = await open('111', 'display-certificate');
    expect(text).toContain('Certified that');
    expect(text).toContain('Lakeview Hospital');
    expect(text).toContain('valid upto 29/07/2022');
    expect(await open('101', 'display-certificate')).toContain('issued with an Occupancy NOC');
  });

  it('renders the rejection letter (rejection.html) with the department’s reason', async () => {
    const text = await open('103', 'rejection');
    expect(text).toContain('Rejected');
    expect(text).toContain('has noticed the following deficiencies');
    expect(text).toContain('mandatory open space');
    expect(text).toContain('Copy to Chief Office for Record Purpose');
  });

  it('renders a payment receipt', async () => {
    const text = await open('111', 'receipt');
    expect(text).toContain('Payment Receipt');
    expect(text).toContain('Online (Payment Gateway)');
  });

  it('explains why a document is unavailable', async () => {
    expect(await open('104', 'certificate')).toContain('available only after the application is approved');
    expect(await open('104', 'acknowledgement')).toContain('once the application is submitted');
  });
});
