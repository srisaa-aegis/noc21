import { Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { isoToLegacy, legacyToIso } from '../../../core/domain/dates';
import { ApplicationDraftStore } from './application-draft.store';

@Component({
  selector: 'app-step-basic',
  imports: [FormsModule],
  templateUrl: './step-basic.html',
  styles: `
    .mode-choice { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-5); margin-bottom: var(--space-3); }
  `,
})
export class StepBasic {
  protected readonly store = inject(ApplicationDraftStore);

  protected readonly stations = computed(() => {
    this.store.issues(); // re-evaluate after changes
    const a = this.store.app();
    const l = this.store.lookups();
    if (!a || !l) return [];
    return (l.fireStations.find((d) => Number(d.id) === Number(a.district))?.stations ?? [])
      .slice()
      .sort((x, y) => x.name.localeCompare(y.name));
  });

  protected isRequiredParty(roleName: string): boolean {
    const a = this.store.app();
    const role = this.store.lookups()?.partyRoles.find((r) => r.role_name === roleName);
    return !!a && !!role?.required_for.includes(a.appl_type);
  }

  protected onDistrictChange(value: number): void {
    const a = this.store.app()!;
    a.district = Number(value);
    a.fire_station_id = 0;
    this.store.touch();
  }

  protected inspectIso(): string {
    return legacyToIso(this.store.app()?.last_inspect_date);
  }

  protected setInspectDate(iso: string): void {
    this.store.set(this.store.app()!, 'last_inspect_date', isoToLegacy(iso));
  }

  protected mcIso(): string {
    return legacyToIso(this.store.app()?.mcapprove_date);
  }

  protected setMcDate(iso: string): void {
    this.store.set(this.store.app()!, 'mcapprove_date', isoToLegacy(iso));
  }

  /** Occupancy mode (legacy "Applying for Occupancy NOC" dialog): M = manual PNOC, N = not applied for. */
  protected setMode(mode: 'M' | 'N'): void {
    const a = this.store.app()!;
    a.appl_mode = mode;
    if (mode === 'N') a.ref_no = '';
    else a.mcapprove_date = '';
    this.store.touch();
  }

  protected setCondition(index: number, value: boolean): void {
    const c = this.store.app()!.conditions![index];
    this.store.set(c, 'selected', value);
  }

  protected showPlotDetails(): boolean {
    const t = this.store.app()?.appl_type;
    return t === 'P' || t === 'O';
  }
}
