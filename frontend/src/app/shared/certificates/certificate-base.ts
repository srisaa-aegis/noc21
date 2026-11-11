import { Directive, computed, input } from '@angular/core';
import { blockArea } from '../../core/domain/application-rules';
import {
  LetterKind,
  buildingClass,
  copyToLines,
  decisionStep,
  extraCopyToLines,
  inspectionDate,
  letterDate,
  signatoryLines,
  termsHtmlForHeight,
} from '../../core/domain/certificate';
import {
  blockBuiltUp,
  blockTotalNbcOccLoad,
  blockTotalOccLoad,
  directionName,
  floorDisplay,
  floorEscapeWidth,
  floorOccuName,
  maxOccuCount,
  maxStairsByLoad,
  proposedEscapeCount,
  proposedEscapeWidth,
  reqdEscapeCount,
  reqdEscapeWidth,
  reqdOpenSpace,
  stairsByLoad,
  t20OccCount,
  totalStairsRequiredByNBC,
} from '../../core/domain/commonrules';
import { ffeColumns } from '../../core/domain/ffe';
import { WizardLookups } from '../../core/lookups/lookup.service';
import { ApplTypeFfeColumn, Application, Block } from '../../core/models';

const CERT_HEADS: Record<string, string> = { reqt: 'Minimum Required', prop: 'Proposed as per PNOC', prov: 'Provided' };

/** Shared inputs and helpers of the printed legal documents (legacy modules/dept/partials/final_noc_*.html). */
@Directive()
export abstract class CertificateBase {
  readonly app = input.required<Application>();
  readonly lookups = input.required<WizardLookups>();
  /** The application this one was carried forward from (Occupancy ← Provisional, Renewal ← Occupancy). */
  readonly parent = input<Application | null>(null);

  protected readonly fn = {
    blockArea,
    blockBuiltUp,
    blockTotalNbcOccLoad,
    blockTotalOccLoad,
    directionName,
    floorDisplay,
    floorEscapeWidth,
    floorOccuName,
    maxStairsByLoad,
    proposedEscapeCount,
    proposedEscapeWidth,
    reqdEscapeCount,
    stairsByLoad,
    t20OccCount,
    totalStairsRequiredByNBC,
  };

  protected readonly msb = computed(() => this.app().delegation_level === 'MSB');
  protected readonly buildingClass = computed(() => buildingClass(this.app().delegation_level));
  protected readonly issueDate = computed(() => letterDate(this.app().final_date));
  protected readonly inspectionDate = computed(() => inspectionDate(this.app()));
  protected readonly decision = computed(() => decisionStep(this.app()));
  protected readonly deficiencies = computed(() => this.decision()?.remarks?.trim() || '-Nil-');
  protected readonly maxHeight = computed(() => Math.max(0, ...this.app().blocks.map((b) => Number(b.height) || 0)));
  protected readonly firstBlock = computed<Block | null>(() => this.app().blocks[0] ?? null);

  /** FFE columns of the application type/mode with the certificate headings. */
  protected readonly ffeCols = computed<ApplTypeFfeColumn[]>(() =>
    ffeColumns(this.lookups().applicationTypes, this.app().appl_type, this.app().appl_mode).map((c) => ({ ...c, head: CERT_HEADS[c.tag] ?? c.head })),
  );

  protected typeName(code: string): string {
    return this.lookups().buildTypes.find((t) => t.code === code)?.name ?? code;
  }

  protected subTypeName(code: string, sub: string): string {
    return this.lookups().buildTypes.find((t) => t.code === code)?.sub.find((s) => s.code === sub)?.name ?? sub;
  }

  /** "Mixed (Residential)" or "Residential" (legacy is_mixed). */
  protected occupancy(block: Block): string {
    return block.is_mixed ? `Mixed (${this.typeName(block.site_type)})` : this.typeName(block.site_type);
  }

  protected districtName(): string {
    return this.app().dist_name || this.lookups().districts.find((d) => d.id === Number(this.app().district))?.desc || '';
  }

  protected reqdOs(block: Block, direc: string): number | string {
    const a = this.app();
    const r = reqdOpenSpace(block, direc, a.plot_area, a.appl_type, a.appl_mode);
    return r < 0 ? '—' : r;
  }

  protected minWidth(block: Block, etype: string): string {
    return reqdEscapeWidth(etype, block.site_type, block.site_stype, maxOccuCount(block));
  }

  protected fixed(v: unknown, digits = 2): string {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(digits) : '—';
  }

  protected signatory(kind: LetterKind): string[] {
    return signatoryLines(kind, this.app().delegation_level, this.districtName(), this.decision()?.role ?? 'DG');
  }

  protected copyTo(kind: LetterKind): string[] {
    return copyToLines(kind, this.app().delegation_level, this.app(), extraCopyToLines(this.app()));
  }

  protected terms(key: 'P' | 'O' | 'R'): string {
    const set = this.lookups().nocTerms[key];
    if (!set) return '';
    return termsHtmlForHeight(this.msb() ? set.MSB : set.NON_MSB, this.maxHeight());
  }

  protected letterDate(value?: string): string {
    return letterDate(value);
  }
}
