import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { blockDelegationLevel, blockRenewalYears, computeFee, delegationLevelName } from '../../core/domain/application-rules';
import { delegationRuleProblems, feeConfigProblems, renewalRuleProblems } from '../../core/domain/config-rules';
import { newBlock } from '../../core/domain/application-factory';
import { LookupService } from '../../core/lookups/lookup.service';
import { BuildType, DelegationRule, FeeConfig, RenewalRule } from '../../core/models';
import { IconComponent } from '../../shared/ui/icon';
import { ToastService } from '../../shared/ui/toast.service';
import { RulesConfigService } from './rules-config.service';

type Tab = 'fees' | 'levels' | 'renewal';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * Admin → Rules & Fees. Maintains the configurable rules that the legacy system had hard-coded:
 * fee rates / penalties / declaration fee / portal charges, the approval level (delegation) rules
 * and the renewal periodicity rules (legacy validations/declaration.rule).
 */
@Component({
  selector: 'app-rules-config',
  imports: [FormsModule, DecimalPipe, IconComponent],
  templateUrl: './rules-config.html',
  styleUrl: './rules-config.scss',
})
export class RulesConfig {
  private readonly service = inject(RulesConfigService);
  private readonly lookups = inject(LookupService);
  private readonly toast = inject(ToastService);

  protected readonly tab = signal<Tab>('fees');
  protected readonly buildTypes = toSignal(this.lookups.buildTypes$, { initialValue: [] as BuildType[] });

  protected readonly fees = signal<FeeConfig | null>(null);
  protected readonly levels = signal<DelegationRule[]>([]);
  protected readonly renewals = signal<RenewalRule[]>([]);
  private original: { fees: FeeConfig; levels: DelegationRule[]; renewals: RenewalRule[] } | null = null;

  /** Bumped on every edit so computed previews refresh. */
  private readonly edits = signal(0);
  protected readonly problems = signal<string[]>([]);

  // "Try it" panels
  protected sample = { area: 1000, years: 3 };
  protected test = { site_type: 'res', site_stype: 'A4', height: 18, is_multiplex: false };

  protected readonly feePreview = computed(() => {
    this.edits();
    const f = this.fees();
    if (!f) return [];
    const block = newBlock(1, 'N');
    block.floors = [{ floor_id: 1, flr_type: 'G', flr_name: 'Ground Floor', built_area: Number(this.sample.area) || 0, occ_type: 'RES', occ_c_app: 0 }];
    const now = new Date();
    const mc = new Date(now.getFullYear() - (Number(this.sample.years) || 0), now.getMonth(), 1);
    const mcDate = `${String(mc.getDate()).padStart(2, '0')}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][mc.getMonth()]}-${mc.getFullYear()}`;
    const cases: { label: string; type: 'P' | 'O' | 'R' | 'D'; mode: string }[] = [
      { label: 'Provisional NOC', type: 'P', mode: '' },
      { label: 'Occupancy NOC (with Provisional NOC)', type: 'O', mode: 'O' },
      { label: `Occupancy NOC without Provisional NOC (approved ${this.sample.years} yr ago)`, type: 'O', mode: 'N' },
      { label: 'Renewal of Occupancy NOC', type: 'R', mode: 'O' },
      { label: 'Declaration for Renewal', type: 'D', mode: '' },
    ];
    return cases.map((c) => ({ label: c.label, fee: computeFee({ appl_type: c.type, appl_mode: c.mode, blocks: [block], mcapprove_date: mcDate }, f, now) }));
  });

  protected readonly testResult = computed(() => {
    this.edits();
    const block = newBlock(1, 'N');
    block.site_type = this.test.site_type;
    block.site_stype = this.test.site_stype;
    block.height = Number(this.test.height) || 0;
    block.is_multiplex = !!this.test.is_multiplex;
    const levels = this.levels();
    const renewals = this.renewals();
    const level = blockDelegationLevel(block, levels);
    const levelRule = levels.findIndex((r) => this.matchOnly(block, r) && (!r.multiplex_only || block.is_multiplex) && this.heightMatch(block.height, r));
    const years = blockRenewalYears(block, renewals);
    const renewalRule = renewals.findIndex((r) => this.matchOnly(block, r) && (r.max_height == null || block.height < r.max_height));
    return { level, levelName: delegationLevelName(level), levelRule: levelRule + 1, years, renewalRule: renewalRule + 1 };
  });

  constructor() {
    this.reload();
  }

  private matchOnly(block: { site_type: string; site_stype: string }, r: { site_types: string[]; site_stypes: string[] }): boolean {
    if (r.site_types.length && !r.site_types.includes(block.site_type)) return false;
    if (r.site_stypes.length && !r.site_stypes.map((s) => s.toUpperCase()).includes(block.site_stype.toUpperCase())) return false;
    return true;
  }

  private heightMatch(h: number, r: DelegationRule): boolean {
    if (r.min_height != null && (r.min_inclusive ? h < r.min_height : h <= r.min_height)) return false;
    if (r.max_height != null && h >= r.max_height) return false;
    return true;
  }

  protected reload(): void {
    this.service.load().subscribe((c) => {
      this.original = clone({ fees: c.feeConfig, levels: c.delegationRules, renewals: c.renewalRules });
      this.fees.set(clone(c.feeConfig));
      this.levels.set(clone(c.delegationRules));
      this.renewals.set(clone(c.renewalRules));
      this.problems.set([]);
      this.edits.update((v) => v + 1);
    });
  }

  protected changed(): void {
    this.edits.update((v) => v + 1);
    this.problems.set([]);
  }

  protected selectTab(t: Tab): void {
    this.tab.set(t);
    this.problems.set([]);
  }

  // ---- Fees --------------------------------------------------------------

  protected saveFees(): void {
    const f = this.fees()!;
    const p = feeConfigProblems(f);
    this.problems.set(p);
    if (p.length) return;
    this.service.saveFees(f).subscribe({
      next: () => {
        this.original!.fees = clone(f);
        this.toast.success('Fee configuration saved. New fees apply to applications from now on.');
      },
      error: (e: Error) => this.toast.error(e.message),
    });
  }

  protected resetFees(): void {
    if (this.original) this.fees.set(clone(this.original.fees));
    this.changed();
  }

  // ---- Shared rule-table helpers -------------------------------------------

  protected hasType(rule: { site_types: string[] }, code: string): boolean {
    return rule.site_types.includes(code);
  }

  protected toggleType(rule: { site_types: string[]; site_stypes: string[] }, code: string): void {
    if (rule.site_types.includes(code)) {
      rule.site_types = rule.site_types.filter((c) => c !== code);
      const subs = this.buildTypes().find((t) => t.code === code)?.sub.map((s) => s.code.toUpperCase()) ?? [];
      rule.site_stypes = rule.site_stypes.filter((s) => !subs.includes(s.toUpperCase()));
    } else {
      rule.site_types = [...rule.site_types, code];
    }
    this.changed();
  }

  protected subTypesFor(rule: { site_types: string[] }): { code: string; name: string }[] {
    return this.buildTypes()
      .filter((t) => rule.site_types.includes(t.code))
      .flatMap((t) => t.sub.map((s) => ({ code: s.code, name: s.name })));
  }

  protected hasSub(rule: { site_stypes: string[] }, code: string): boolean {
    return rule.site_stypes.map((s) => s.toUpperCase()).includes(code.toUpperCase());
  }

  protected toggleSub(rule: { site_stypes: string[] }, code: string): void {
    rule.site_stypes = this.hasSub(rule, code) ? rule.site_stypes.filter((s) => s.toUpperCase() !== code.toUpperCase()) : [...rule.site_stypes, code];
    this.changed();
  }

  protected typeNames(rule: { site_types: string[]; site_stypes: string[] }): string {
    if (!rule.site_types.length) return 'All occupancies';
    const names = rule.site_types.map((c) => this.buildTypes().find((t) => t.code === c)?.name ?? c).join(', ');
    return rule.site_stypes.length ? `${names} (${rule.site_stypes.join(', ')})` : names;
  }

  protected numOrNull(v: unknown): number | null {
    return v === null || v === undefined || v === '' ? null : Number(v);
  }

  private move<T>(list: T[], i: number, d: number): T[] {
    const j = i + d;
    if (j < 0 || j >= list.length) return list;
    const copy = [...list];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    return copy;
  }

  // ---- Approval levels -----------------------------------------------------

  protected moveLevel(i: number, d: number): void {
    this.levels.set(this.move(this.levels(), i, d));
    this.changed();
  }

  protected addLevel(): void {
    const list = this.levels();
    const id = list.reduce((m, r) => Math.max(m, r.id), 0) + 1;
    const rule: DelegationRule = { id, level: 'RFO', label: 'New rule', site_types: [], site_stypes: [], min_height: 10, min_inclusive: false, max_height: null };
    // insert before the catch-all last rule
    const copy = [...list];
    copy.splice(Math.max(0, copy.length - 1), 0, rule);
    this.levels.set(copy);
    this.changed();
  }

  protected removeLevel(i: number): void {
    this.levels.set(this.levels().filter((_, k) => k !== i));
    this.changed();
  }

  protected saveLevels(): void {
    const rules = this.levels();
    const p = delegationRuleProblems(rules);
    this.problems.set(p);
    if (p.length) return;
    this.service.saveDelegationRules(rules).subscribe({
      next: () => {
        this.original!.levels = clone(rules);
        this.toast.success('Approval level rules saved. They apply to applications submitted from now on.');
      },
      error: (e: Error) => this.toast.error(e.message),
    });
  }

  protected resetLevels(): void {
    if (this.original) this.levels.set(clone(this.original.levels));
    this.changed();
  }

  protected heightText(r: DelegationRule): string {
    const parts: string[] = [];
    if (r.min_height != null) parts.push(`${r.min_inclusive ? '≥' : '>'} ${r.min_height} m`);
    if (r.max_height != null) parts.push(`< ${r.max_height} m`);
    return parts.length ? parts.join(' and ') : 'Any height';
  }

  // ---- Renewal periods -----------------------------------------------------

  protected moveRenewal(i: number, d: number): void {
    this.renewals.set(this.move(this.renewals(), i, d));
    this.changed();
  }

  protected addRenewal(): void {
    const list = this.renewals();
    const id = list.reduce((m, r) => Math.max(m, r.id), 0) + 1;
    const copy = [...list];
    copy.splice(Math.max(0, copy.length - 1), 0, { id, label: 'New rule', site_types: [], site_stypes: [], max_height: 18, years: 3 });
    this.renewals.set(copy);
    this.changed();
  }

  protected removeRenewal(i: number): void {
    this.renewals.set(this.renewals().filter((_, k) => k !== i));
    this.changed();
  }

  protected saveRenewals(): void {
    const rules = this.renewals();
    const p = renewalRuleProblems(rules);
    this.problems.set(p);
    if (p.length) return;
    this.service.saveRenewalRules(rules).subscribe({
      next: () => {
        this.original!.renewals = clone(rules);
        this.toast.success('Renewal periods saved. They apply to certificates issued from now on.');
      },
      error: (e: Error) => this.toast.error(e.message),
    });
  }

  protected resetRenewals(): void {
    if (this.original) this.renewals.set(clone(this.original.renewals));
    this.changed();
  }

  protected testSubTypes(): { code: string; name: string }[] {
    return this.buildTypes().find((t) => t.code === this.test.site_type)?.sub ?? [];
  }
}
