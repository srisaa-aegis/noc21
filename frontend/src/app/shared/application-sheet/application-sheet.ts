import { DecimalPipe } from '@angular/common';
import { Component, computed, input } from '@angular/core';
import { blockArea, delegationLevelName } from '../../core/domain/application-rules';
import {
  directionName,
  blockBuiltUpO,
  blockTotalNbcOccLoad,
  blockTotalNbcOccLoadO,
  blockTotalOccLoad,
  blockTotalOccLoadO,
  floorDesc,
  floorDisplay,
  floorOccuName,
  floorTypeName,
  maxOccuCount,
  openSpaceMessage,
  reqdEscapeWidth,
  reqdOpenSpace,
  stairTypeName,
  t20OccCount,
  t20OccCountO,
} from '../../core/domain/commonrules';
import { requiredDocuments } from '../../core/domain/documents';
import { ffeColumns } from '../../core/domain/ffe';
import { WizardLookups } from '../../core/lookups/lookup.service';
import { Application, Block } from '../../core/models';
import { FfeGrid } from '../ffe/ffe-grid';
import { FileLink } from '../files/file-link';

export type SheetSection = 'general' | 'parties' | 'blocks' | 'conditions' | 'documents' | 'payment';

const ALL: SheetSection[] = ['general', 'parties', 'blocks', 'conditions', 'documents', 'payment'];

/**
 * Read-only, single-page rendering of a whole application — legacy confirmpnoc / confirmonoc /
 * confirmrnoc ("Confirmation before Submission"). Also used by the application detail page.
 */
@Component({
  selector: 'app-application-sheet',
  imports: [DecimalPipe, FfeGrid, FileLink],
  templateUrl: './application-sheet.html',
  styleUrl: './application-sheet.scss',
})
export class ApplicationSheet {
  readonly app = input.required<Application>();
  readonly lookups = input.required<WizardLookups>();
  readonly sections = input<SheetSection[]>(ALL);
  /** Blocks start collapsed (detail page) or expanded (confirmation page). */
  readonly collapsible = input(false);

  protected readonly fn = { directionName, floorDisplay, floorOccuName, floorTypeName, stairTypeName, t20OccCount, t20OccCountO, blockArea, blockBuiltUpO, blockTotalOccLoad, blockTotalNbcOccLoad, blockTotalOccLoadO, blockTotalNbcOccLoadO, openSpaceMessage };

  protected readonly ffeCols = computed(() => ffeColumns(this.lookups().applicationTypes, this.app().appl_type, this.app().appl_mode));

  protected readonly totalBuiltUp = computed(() => this.app().blocks.reduce((s, b) => s + blockArea(b), 0));

  protected readonly docs = computed(() => {
    const a = this.app();
    return requiredDocuments(a, this.lookups().documentRequirements).map((d) => ({ ...d, file: a.documents.find((x) => x.code === d.code) }));
  });

  protected readonly extraDocs = computed(() => {
    const codes = new Set(this.docs().map((d) => d.code));
    return this.app().documents.filter((d) => !codes.has(d.code));
  });

  protected show(s: SheetSection): boolean {
    return this.sections().includes(s);
  }

  protected typeName(code: string): string {
    return this.lookups().buildTypes.find((t) => t.code === code)?.name ?? code;
  }

  protected subTypeName(code: string, sub: string): string {
    const s = this.lookups().buildTypes.find((t) => t.code === code)?.sub.find((x) => x.code === sub);
    return s ? `${s.code} — ${s.name}` : sub;
  }

  protected stationName(): string {
    const a = this.app();
    return this.lookups().fireStations.find((d) => d.id === Number(a.district))?.stations.find((s) => s.id === a.fire_station_id)?.name ?? (a.fire_station_id ? String(a.fire_station_id) : '—');
  }

  protected levelName(): string {
    return delegationLevelName(this.app().delegation_level);
  }

  protected sideType(code: string): string {
    return this.lookups().blockOptions.sidePropertyTypes.find((t) => t.code === code)?.name ?? code;
  }

  protected blockTypeName(code: string): string {
    return this.lookups().blockOptions.blockTypes.find((t) => t.code === code)?.name ?? 'Normal';
  }

  /** Occupancy carried forward from a Provisional NOC (comparison columns). */
  protected hasParent(): boolean {
    const a = this.app();
    return a.appl_type === 'O' && a.appl_mode !== 'N';
  }

  /** Required open space is checked (and blocks submission) for every type with blocks. */
  protected showsRequiredOpenSpace(): boolean {
    return this.app().appl_type !== 'D';
  }

  protected reqdOs(block: Block, direc: string): number {
    const a = this.app();
    return reqdOpenSpace(block, direc, a.plot_area, a.appl_type, a.appl_mode);
  }

  protected osOk(block: Block, direc: string, proposed: number): boolean {
    const r = this.reqdOs(block, direc);
    return r >= 0 && Number(proposed) >= r;
  }

  protected minWidth(block: Block, etype: string): string {
    return reqdEscapeWidth(etype, block.site_type, block.site_stype, maxOccuCount(block));
  }

  protected floorName(block: Block, id: number | undefined): string {
    if (!id) return 'All floors';
    return floorDesc(block, id) || '—';
  }
}
