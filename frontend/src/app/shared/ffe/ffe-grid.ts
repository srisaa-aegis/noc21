import { Component, computed, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ffeBlockValue, ffeFloorTotal, ffeNoteKeys, ffeNoteText, FfeTag } from '../../core/domain/ffe';
import { ffeCellNeedsInput } from '../../core/domain/validation';
import { floorTypeName } from '../../core/domain/commonrules';
import { ApplTypeFfeColumn, Block, Equipment, FfeCell, FfeItem, FfeNotes } from '../../core/models';

/**
 * Fire safety systems of one block, laid out like the legacy editpnoc_3 / editonoc_3 / confirm pages:
 *  1. "Minimum required Fire Safety Systems" — one row per system with the block-level value
 *     (building items) or the cumulative total of the floor values (floor-wise items);
 *  2. "Floor-wise Fire Safety Systems" — floors × systems, a "Total" row carrying the building-level
 *     items; each cell shows one value per column of the application type/mode (ApplTypes.txt ffe[]),
 *     as text or as an input;
 *  3. the notes (FFE_Notes.txt) that apply.
 *
 * Used read-only by the confirmation page, application detail and certificates.
 */
@Component({
  selector: 'app-ffe-grid',
  imports: [FormsModule],
  templateUrl: './ffe-grid.html',
  styleUrl: './ffe-grid.scss',
  host: { '[class.ffe--document]': "variant() === 'document'" },
})
export class FfeGrid {
  readonly block = input.required<Block>();
  readonly columns = input.required<ApplTypeFfeColumn[]>();
  readonly equipments = input.required<Equipment[]>();
  readonly notes = input<FfeNotes>({});
  /** Render every column as text (confirmation / detail / print). */
  readonly readonly = input(false);
  readonly showSummary = input(true);
  readonly showGrid = input(true);
  readonly showNotes = input(true);
  /** Heading level styling: 'h3' inside forms, 'h4' inside documents. */
  readonly compact = input(false);
  /** Show the section titles (hidden in certificates, which number their own paragraphs). */
  readonly titles = input(true);
  /** 'document' = plain black-bordered tables for the printed certificates. */
  readonly variant = input<'app' | 'document'>('app');
  /** Highlight empty input cells (submission validation). */
  readonly highlightMissing = input(true);
  /** Emitted after a value was edited in place. */
  readonly changed = output<void>();
  /** Remove an item the applicant added (legacy Occupancy "Add Fire Fighting Equipment"). */
  readonly removeItem = output<number>();

  protected readonly floorTypeName = floorTypeName;

  protected readonly items = computed(() => this.block().ffe?.items ?? []);

  protected readonly noteList = computed(() => {
    const ffe = this.block().ffe;
    if (!ffe) return [];
    const n = this.notes();
    return ffeNoteKeys(ffe).map((k) => ({ key: k, text: ffeNoteText(k, n) }));
  });

  protected equipment(id: number): Equipment | undefined {
    return this.equipments().find((e) => e.id === id);
  }

  protected short(id: number): string {
    return this.equipment(id)?.short ?? `#${id}`;
  }

  protected suffix(id: number): string {
    return (this.equipment(id)?.suffix ?? '').trim();
  }

  protected isInput(col: ApplTypeFfeColumn): boolean {
    return col.type === 'input' && !this.readonly();
  }

  /** Text of a value: numbers with the equipment unit, note-based requirements as "As per Note x". */
  protected text(item: FfeItem, v: number | string | null | undefined, withSuffix = true): string {
    if (v === null || v === undefined || v === '') return '--';
    if (typeof v === 'number') return withSuffix && this.suffix(item.equip_id) ? `${v} ${this.suffix(item.equip_id)}` : String(v);
    if (/^\d+(\.\d+)?$/.test(v)) return withSuffix && this.suffix(item.equip_id) ? `${v} ${this.suffix(item.equip_id)}` : v;
    return `As per ${v}`;
  }

  protected tagOf(col: ApplTypeFfeColumn): FfeTag {
    return col.tag as FfeTag;
  }

  protected val(cell: FfeCell, col: ApplTypeFfeColumn): number | string | null {
    return cell[col.tag as FfeTag] ?? null;
  }

  protected isNote(v: number | string | null | undefined): boolean {
    return typeof v === 'string' && v !== '' && !/^\d+(\.\d+)?$/.test(v);
  }

  protected summaryValue(item: FfeItem, tag: FfeTag): string {
    return this.text(item, ffeBlockValue(item, tag));
  }

  protected floorTotal(item: FfeItem, tag: FfeTag): string {
    const any = Object.values(item.floors).some((c) => c[tag] !== null && c[tag] !== undefined && c[tag] !== '');
    return any ? String(ffeFloorTotal(item, tag)) : '--';
  }

  protected cell(item: FfeItem, floorId: number): FfeCell | undefined {
    return item.floors[String(floorId)];
  }

  protected inputValue(cell: FfeCell, tag: FfeTag): number | string | null {
    const v = cell[tag];
    return v === null || v === undefined ? null : v;
  }

  protected setValue(cell: FfeCell, tag: FfeTag, raw: unknown): void {
    const s = raw === null || raw === undefined ? '' : String(raw).trim();
    (cell as unknown as Record<string, unknown>)[tag] = s === '' ? null : Number.isFinite(Number(s)) ? Number(s) : s;
    this.changed.emit();
  }

  protected missing(item: FfeItem, cell: FfeCell, tag: FfeTag): boolean {
    if (!this.highlightMissing() || this.readonly()) return false;
    const v = cell[tag];
    return ffeCellNeedsInput(item, cell) && (v === null || v === undefined || String(v) === '');
  }

  protected isShort(item: FfeItem, cell: FfeCell): boolean {
    if (typeof cell.prov !== 'number') return false;
    const target = typeof cell.prop === 'number' ? cell.prop : typeof cell.reqt === 'number' ? cell.reqt : null;
    return target !== null && cell.prov < target;
  }

  protected canRemove(item: FfeItem): boolean {
    return !!item.added && !this.readonly() && item.block.reqt === null && Object.values(item.floors).every((c) => c.reqt === null);
  }
}
