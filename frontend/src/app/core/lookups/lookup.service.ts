import { Injectable, inject } from '@angular/core';
import { Observable, combineLatest, forkJoin, map, shareReplay, switchMap, take } from 'rxjs';
import { ApiClient } from '../api/api-client.service';
import { API_ENDPOINTS, ApiEndpoint } from '../api/api-endpoints';
import { BUNDLE_KEYS } from '../api/bundle-keys';
import { ReferenceDataStore } from '../api/reference-data.store';
import { ValidationContext } from '../domain/validation';
import {
  ApplicationType,
  BlockOptions,
  BuildType,
  DelegationRule,
  DeptRole,
  Direction,
  District,
  DistrictFireStations,
  DocumentRequirements,
  Equipment,
  EscapeRules,
  FeeConfig,
  FfeNotes,
  FfeRuleSet,
  HtmlReference,
  Hazard,
  MappedCode,
  NocTerms,
  OccupancyCondition,
  PartyRole,
  RenewalRule,
  Region,
  FormDef,
  SlaConfig,
  WorkflowDefinition,
  RuleTree,
  StatusCode,
  Undertakings,
} from '../models';

/** Admin-configurable rules — always read fresh so admin changes apply immediately. */
/** Workflow configuration (Phase 3). */
export interface WorkflowConfig {
  workflows: WorkflowDefinition[];
  sla: SlaConfig;
  forms: FormDef[];
  roles: DeptRole[];
  regions: Region[];
}

export interface RulesConfig {
  feeConfig: FeeConfig;
  delegationRules: DelegationRule[];
  renewalRules: RenewalRule[];
}

/** Everything the application wizard, confirmation and print pages need. */
export interface WizardLookups extends ValidationContext, RulesConfig {
  districts: District[];
  fireStations: DistrictFireStations[];
  equipments: Equipment[];
  ffeNotes: FfeNotes;
  ffeRules: FfeRuleSet;
  blockOptions: BlockOptions;
  directions: Direction[];
  occupancyConditions: OccupancyCondition[];
  nocTerms: NocTerms;
  undertakings: Undertakings;
}

/**
 * Single access point for master/reference data and rules. Static lookups are fetched once per
 * session (`shareReplay(1)`); the admin-editable configuration is re-read on every request.
 */
@Injectable({ providedIn: 'root' })
export class LookupService {
  private readonly api = inject(ApiClient);
  private readonly store = inject(ReferenceDataStore);

  /**
   * Reference data, rule definitions and configuration come from the cached
   * bundles (one download per change instead of ~25 requests per page —
   * docs/backend/55-caching.md); anything not in a bundle is a plain API read.
   */
  private fromCache<T>(endpoint: ApiEndpoint, params?: Record<string, string | number>): Observable<T> | null {
    const mapping = BUNDLE_KEYS[endpoint.id];
    if (!mapping) return null;
    const key = typeof mapping.key === 'function' ? mapping.key(params ?? {}) : mapping.key;
    return this.store.observable<T>(mapping.bundle, key);
  }

  private cached<T>(endpoint: ApiEndpoint, params?: Record<string, string | number>): Observable<T> {
    return (this.fromCache<T>(endpoint, params) ?? this.api.get<T>(endpoint, params)).pipe(shareReplay(1));
  }

  /** Always-fresh read (admin-editable configuration). */
  private live<T>(endpoint: ApiEndpoint, params?: Record<string, string | number>): Observable<T> {
    return this.fromCache<T>(endpoint, params) ?? this.api.get<T>(endpoint, params);
  }

  readonly applicationTypes$ = this.cached<ApplicationType[]>(API_ENDPOINTS.lookupApplicationTypes);
  readonly buildTypes$ = this.cached<BuildType[]>(API_ENDPOINTS.lookupBuildTypes);
  readonly directions$ = this.cached<Direction[]>(API_ENDPOINTS.lookupDirections);
  readonly districts$ = this.cached<District[]>(API_ENDPOINTS.lookupDistricts);
  readonly fireStations$ = this.cached<DistrictFireStations[]>(API_ENDPOINTS.lookupFireStations);
  readonly hazards$ = this.cached<Hazard[]>(API_ENDPOINTS.lookupHazards);
  readonly mappedCodes$ = this.cached<MappedCode[]>(API_ENDPOINTS.lookupMappedCodes);
  readonly equipments$ = this.cached<Equipment[]>(API_ENDPOINTS.lookupEquipments);
  readonly ffeNotes$ = this.cached<FfeNotes>(API_ENDPOINTS.lookupFfeNotes);
  readonly statuses$ = this.cached<StatusCode[]>(API_ENDPOINTS.lookupStatuses);
  readonly regions$ = this.cached<Region[]>(API_ENDPOINTS.lookupRegions);
  readonly forms$ = this.cached<FormDef[]>(API_ENDPOINTS.configForms);
  readonly deptRoles$ = this.cached<DeptRole[]>(API_ENDPOINTS.lookupDeptRoles);
  readonly partyRoles$ = this.cached<PartyRole[]>(API_ENDPOINTS.lookupPartyRoles);
  readonly blockOptions$ = this.cached<BlockOptions>(API_ENDPOINTS.lookupBlockOptions);
  readonly documentRequirements$ = this.cached<DocumentRequirements>(API_ENDPOINTS.lookupDocumentRequirements);
  readonly escapeRules$ = this.cached<EscapeRules>(API_ENDPOINTS.lookupEscapeRules);
  readonly nocTerms$ = this.cached<NocTerms>(API_ENDPOINTS.lookupNocTerms);
  readonly occupancyConditions$ = this.cached<OccupancyCondition[]>(API_ENDPOINTS.lookupOccupancyConditions);
  readonly nbcTable7$ = this.cached<HtmlReference>(API_ENDPOINTS.lookupNbcTable7);
  readonly undertakings$ = this.cached<Undertakings>(API_ENDPOINTS.lookupUndertakings);
  readonly heightLimits$ = this.cached<RuleTree>(API_ENDPOINTS.rulesHeightLimits);

  /** All FFE decision trees: one per equipment id (where a rule file exists) plus the auxiliary trees. */
  readonly ffeRules$: Observable<FfeRuleSet> = this.equipments$.pipe(
    switchMap((eqs) => {
      const ids = eqs.map((e) => e.id).filter((id) => id >= 1 && id <= 12);
      return forkJoin({
        trees: forkJoin(ids.map((id) => this.live<RuleTree>(API_ENDPOINTS.rulesFfeEquipment, { id }).pipe(map((t) => [id, t] as const)))),
        ffeType: this.live<RuleTree>(API_ENDPOINTS.rulesFfeType),
        otherNotes: this.live<RuleTree>(API_ENDPOINTS.rulesOtherNotes),
        riserWidth: this.live<RuleTree>(API_ENDPOINTS.rulesRiserWidth),
      });
    }),
    map(({ trees, ffeType, otherNotes, riserWidth }) => ({
      equipment: Object.fromEntries(trees) as Record<number, RuleTree>,
      ffeType,
      otherNotes,
      riserWidth,
    })),
    shareReplay(1),
  );

  /** Admin-editable workflow configuration (workflows + SLA), read fresh on every call. */
  workflowConfig(): Observable<WorkflowConfig> {
    return forkJoin({
      workflows: this.live<WorkflowDefinition[]>(API_ENDPOINTS.configWorkflows),
      sla: this.live<SlaConfig>(API_ENDPOINTS.configSla),
      forms: this.forms$.pipe(take(1)),
      roles: this.deptRoles$.pipe(take(1)),
      regions: this.regions$.pipe(take(1)),
    });
  }

  /** Admin-editable rules, read fresh on every call. */
  config(): Observable<RulesConfig> {
    return forkJoin({
      feeConfig: this.live<FeeConfig>(API_ENDPOINTS.configFees),
      delegationRules: this.live<DelegationRule[]>(API_ENDPOINTS.configDelegationRules),
      renewalRules: this.live<RenewalRule[]>(API_ENDPOINTS.configRenewalRules),
    });
  }

  private readonly staticWizard$ = combineLatest({
    applicationTypes: this.applicationTypes$,
    buildTypes: this.buildTypes$,
    partyRoles: this.partyRoles$,
    documentRequirements: this.documentRequirements$,
    escapeRules: this.escapeRules$,
    heightLimits: this.heightLimits$,
    districts: this.districts$,
    fireStations: this.fireStations$,
    equipments: this.equipments$,
    ffeNotes: this.ffeNotes$,
    ffeRules: this.ffeRules$,
    blockOptions: this.blockOptions$,
    directions: this.directions$,
    occupancyConditions: this.occupancyConditions$,
    nocTerms: this.nocTerms$,
    undertakings: this.undertakings$,
  }).pipe(shareReplay(1));

  /** Static lookups + the current admin configuration. */
  wizard(): Observable<WizardLookups> {
    return combineLatest([this.staticWizard$, this.config()]).pipe(map(([s, c]) => ({ ...s, ...c })));
  }

  /** Fire stations for a district id. */
  stationsFor(all: DistrictFireStations[], districtId: number): { id: number; name: string }[] {
    return all.find((d) => d.id === Number(districtId))?.stations ?? [];
  }

  readonly districtNames$: Observable<Map<number, string>> = this.districts$.pipe(
    map((list) => new Map(list.map((d) => [d.id, d.desc]))),
    shareReplay(1),
  );
}
