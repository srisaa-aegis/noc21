/**
 * Test-only fake of the NOC backend for the component and service suites.
 *
 * An HTTP interceptor answers the REST routes the portal calls (the same URLs
 * as `api-endpoints.ts`) with route-shaped responses built from the demo seed
 * data (backend/seed/data), with a thin in-memory model of the writes. Every
 * request is recorded, so a test can assert what the page sent; any route can
 * be overridden (`api.on(...)`) or made to fail (`api.fail(...)`).
 *
 * The real transactions, calculations and permissions are tested against the
 * real backend (backend/tests) and in the browser (e2e/).
 *
 *   TestBed.configureTestingModule({ providers: [provideFakeApi()] });
 *   const api = TestBed.inject(FakeApi);
 */
import { HttpErrorResponse, HttpInterceptorFn, HttpRequest, HttpResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { EnvironmentProviders, Provider } from '@angular/core';
import { Observable, of, throwError } from 'rxjs';
import { RuleEngine } from '@srisaa/rules-engine';
import { InMemoryRuleSetSource } from '@srisaa/rules-engine/testing';
import {
  RULE_SETS,
  assess,
  delegationRulesToTable,
  escapeRulesToParameters,
  feeConfigToParameters,
  feedbackSummary,
  formatLegacyDate,
  monitoredApplications,
  myTasks,
  occupancyFromProvisional,
  renewalFromOccupancy,
  renewalRulesToTable,
  toSummary,
  type Application,
  type DeptRole,
  type FormDef,
  type SlaConfig,
  type UserAccount,
  type WorkflowDefinition,
} from '@srisaa/noc-domain';
import * as oracle from '@srisaa/noc-domain';
import { FIXTURES } from './fixture-index';

const API = '/api/v1';
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
export function fixture<T>(asset: string): T {
  const data = FIXTURES[asset];
  if (data === undefined) throw new Error(`No fixture for ${asset}`);
  return clone(data) as T;
}

type SeedUser = UserAccount & { aadhar?: string };

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

type Handler = (req: { params: string[]; query: Record<string, string>; body: unknown; raw: HttpRequest<unknown> }) => unknown;

export class FakeApiError {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly errors?: { field: string; message: string }[],
  ) {}
}

const STATUS_META: Record<number, { category: string; badge: string; is_system: boolean; is_pre_decision: boolean }> = {
  1: { category: 'draft', badge: 'DRF', is_system: true, is_pre_decision: false },
  2: { category: 'submitted', badge: 'SUB', is_system: true, is_pre_decision: false },
  3: { category: 'in_process', badge: 'INS', is_system: false, is_pre_decision: false },
  4: { category: 'in_process', badge: 'REV', is_system: false, is_pre_decision: false },
  5: { category: 'in_process', badge: 'REV', is_system: false, is_pre_decision: false },
  6: { category: 'in_process', badge: 'PFA', is_system: false, is_pre_decision: true },
  7: { category: 'approved', badge: 'ISS', is_system: true, is_pre_decision: false },
  8: { category: 'returned', badge: 'RET', is_system: true, is_pre_decision: false },
  9: { category: 'rejected', badge: 'REJ', is_system: true, is_pre_decision: false },
};

export class FakeApi {
  readonly apps: Application[] = fixture<Application[]>('assets/data/applications/applications.json').map((a, i) => ({ ...a, row_version: 1 + i * 0 }));
  readonly users: SeedUser[] = fixture<SeedUser[]>('assets/data/auth/users.json');
  readonly requests: RecordedRequest[] = [];
  private readonly routes: { method: string; pattern: RegExp; handle: Handler }[] = [];
  private readonly overrides: { method: string; pattern: RegExp; handle: Handler }[] = [];
  private engine?: RuleEngine;

  readonly roles = fixture<DeptRole[]>('assets/data/lookups/dept-roles.json');
  readonly forms = fixture<FormDef[]>('assets/data/config/forms.json');
  readonly sla = fixture<SlaConfig>('assets/data/config/sla.json');
  readonly workflows: WorkflowDefinition[] = fixture<WorkflowDefinition[]>('assets/data/config/workflows.json').map((w, i) => ({ ...w, id: i + 1 }));
  statuses = fixture<{ code: number; desc: string }[]>('assets/data/lookups/statuses.json').map((s) => ({ ...s, ...STATUS_META[s.code], sort_order: s.code, active: true }));
  feeConfig = fixture<Record<string, unknown>>('assets/data/config/fee-config.json');
  delegationRules = fixture<unknown[]>('assets/data/config/delegation-rules.json');
  renewalRules = fixture<unknown[]>('assets/data/config/renewal-rules.json');
  readonly escalationLog: oracle.EscalationLogEntry[] = [];
  /** Audit entries the fake serves (a test may add more). */
  readonly audit = [
    { id: 3, at: '2026-11-07T10:15:00.000Z', requestId: 'r3', actorUsername: 'admin', actorPortal: 'admin', action: 'status.added', entityType: 'status', entityId: '10', summary: 'Status "Reviewed (Legal)" added', ip: '127.0.0.1' },
    { id: 2, at: '2026-11-06T09:00:00.000Z', requestId: 'r2', actorUsername: 'dg.officer', actorPortal: 'dept', action: 'workflow.decided', entityType: 'application', entityId: '101', summary: 'Approved', ip: '127.0.0.1' },
    { id: 1, at: '2026-11-05T08:00:00.000Z', requestId: 'r1', actorUsername: 'citizen1', actorPortal: 'citizen', action: 'application.submitted', entityType: 'application', entityId: '101', summary: 'Submitted', ip: '127.0.0.1' },
  ];
  /** "Now" of the fake (dates it writes). */
  now = new Date();

  constructor() {
    this.define();
  }

  // ── test API ──────────────────────────────────────────────────────────────

  /** Overrides a route: `api.on('GET', /^\/dept\/tasks$/, () => ({ items: [] }))`. */
  on(method: string, pattern: RegExp, handle: Handler): this {
    this.overrides.unshift({ method, pattern, handle });
    return this;
  }

  /** Makes a route fail with a problem+json response. */
  fail(method: string, pattern: RegExp, status: number, detail: string, errors?: { field: string; message: string }[]): this {
    return this.on(method, pattern, () => {
      throw new FakeApiError(status, detail, errors);
    });
  }

  /** The built-in answer of a route (ignoring overrides) — for an override that adjusts it. */
  handleSync(method: string, path: string, query: Record<string, string> = {}, body: unknown = null): unknown {
    for (const r of this.routes) {
      const m = r.method === method ? r.pattern.exec(path) : null;
      if (m) return r.handle({ params: m.slice(1), query, body, raw: new HttpRequest(method as 'GET', path) });
    }
    throw new FakeApiError(404, `No fake route for ${method} ${path}`);
  }

  /** Requests recorded for a method + path pattern. */
  calls(method: string, pattern: RegExp): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && pattern.test(r.path));
  }

  app(id: number): Application {
    const a = this.apps.find((x) => x.appl_id === id);
    if (!a) throw new FakeApiError(404, 'Application not found.');
    return a;
  }

  account(id: number): SeedUser {
    const u = this.users.find((x) => x.id === id);
    if (!u) throw new FakeApiError(404, 'Account not found.');
    return u;
  }

  sessionUser(): SeedUser | undefined {
    try {
      const raw = sessionStorage.getItem('noc.session');
      const username = raw ? (JSON.parse(raw) as { username: string }).username : '';
      return this.users.find((u) => u.username === username);
    } catch {
      return undefined;
    }
  }

  // ── dispatch ──────────────────────────────────────────────────────────────

  handle(req: HttpRequest<unknown>): Observable<HttpResponse<unknown>> {
    const url = new URL(req.urlWithParams, 'http://portal.test');
    const path = url.pathname.startsWith(API) ? url.pathname.slice(API.length) : url.pathname;
    const query = Object.fromEntries(url.searchParams.entries());
    let body: unknown = req.body;
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const o: Record<string, unknown> = {};
      body.forEach((v, k) => (o[k] = v instanceof Blob ? { name: (v as File).name, size: v.size } : v));
      body = o;
    }
    this.requests.push({ method: req.method, path, query, body });
    for (const r of [...this.overrides, ...this.routes]) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(path);
      if (!m) continue;
      try {
        const result = r.handle({ params: m.slice(1), query, body, raw: req });
        return of(new HttpResponse({ status: req.method === 'POST' && result === undefined ? 204 : 200, url: req.url, body: result instanceof Blob ? result : clone(result ?? null) }));
      } catch (e) {
        if (!(e instanceof FakeApiError)) console.warn(`[fake-api] ${req.method} ${path} threw`, e);
        const err = e instanceof FakeApiError ? e : new FakeApiError(500, (e as Error).message);
        return throwError(
          () =>
            new HttpErrorResponse({
              status: err.status,
              url: req.url,
              error: { type: 'https://noc.portal/errors/test', title: 'Error', status: err.status, detail: err.detail, errors: err.errors },
            }),
        );
      }
    }
    console.warn(`[fake-api] no route for ${req.method} ${path}`);
    return throwError(() => new HttpErrorResponse({ status: 404, url: req.url, error: { detail: `No fake route for ${req.method} ${path}` } }));
  }

  private route(method: string, pattern: RegExp, handle: Handler): void {
    this.routes.push({ method, pattern, handle });
  }

  // ── derived data ──────────────────────────────────────────────────────────

  private officers() {
    return this.users
      .filter((u) => u.portal === 'dept')
      .map((u) => ({ id: u.id, username: u.username, displayName: u.displayName, role_id: u.role_id!, district_id: u.district ?? null, all_stations: !!u.all_stations, fire_station_ids: u.fire_station_ids ?? [], active: u.active !== false }));
  }

  bundle(name: string): unknown {
    const f = <T>(p: string) => fixture<T>(`assets/data/${p}`);
    switch (name) {
      case 'reference':
        return {
          applicationTypes: f('lookups/application-types.json'),
          buildTypes: f('lookups/build-types.json'),
          directions: f('lookups/directions.json'),
          districts: f('lookups/districts.json'),
          fireStations: f('lookups/fire-stations.json'),
          regions: f('lookups/regions.json'),
          hazards: f('lookups/hazards.json'),
          mappedCodes: f('lookups/mapped-codes.json'),
          equipments: f('lookups/equipments.json'),
          ffeNotes: f('lookups/ffe-notes.json'),
          statuses: clone(this.statuses),
          deptRoles: clone(this.roles),
          partyRoles: f('lookups/party-roles.json'),
          blockOptions: f('lookups/block-options.json'),
          documentRequirements: f('lookups/document-requirements.json'),
          occupancyConditions: f('lookups/occupancy-conditions.json'),
          undertakings: f('lookups/undertakings.json'),
        };
      case 'rules': {
        const ffe: Record<string, unknown> = {};
        for (const key of Object.keys(FIXTURES)) {
          const m = /^assets\/data\/rules\/ffe\/(\d+)\.json$/.exec(key);
          if (m) ffe[m[1]] = f(`rules/ffe/${m[1]}.json`);
        }
        return {
          ffe,
          ffeType: f('rules/ffe-type.json'),
          otherNotes: f('rules/other-notes.json'),
          riserWidth: f('rules/riser-width.json'),
          heightLimits: f('rules/height-limits.json'),
          feeConfig: clone(this.feeConfig),
          delegationRules: clone(this.delegationRules),
          renewalRules: clone(this.renewalRules),
          escapeRules: f('lookups/escape-rules.json'),
          versions: {},
        };
      }
      case 'content':
        return { nocTerms: f('lookups/noc-terms.json'), nbcTable7: f('lookups/nbc-table7.json') };
      case 'workflow':
        return { workflows: clone(this.workflows), forms: clone(this.forms), sla: clone(this.sla) };
      case 'directory':
        return { officers: this.officers() };
      default:
        throw new FakeApiError(404, `No bundle ${name}.`);
    }
  }

  private ruleEngine(): RuleEngine {
    if (this.engine) return this.engine;
    const source = new InMemoryRuleSetSource();
    const rules = this.bundle('rules') as Record<string, unknown> & { ffe: Record<string, unknown> };
    for (const [id, tree] of Object.entries(rules.ffe)) source.add(RULE_SETS.ffeEquipment(Number(id)), 'decision_tree', tree as never);
    source.add(RULE_SETS.ffeType, 'decision_tree', rules['ffeType'] as never);
    source.add(RULE_SETS.ffeOtherNotes, 'decision_tree', rules['otherNotes'] as never);
    source.add(RULE_SETS.ffeRiserWidth, 'decision_tree', rules['riserWidth'] as never);
    source.add(RULE_SETS.heightLimits, 'decision_tree', rules['heightLimits'] as never);
    source.add(RULE_SETS.approvalLevel, 'decision_table', delegationRulesToTable(rules['delegationRules'] as never));
    source.add(RULE_SETS.renewalPeriod, 'decision_table', renewalRulesToTable(rules['renewalRules'] as never));
    source.add(RULE_SETS.fees, 'parameters', feeConfigToParameters(rules['feeConfig'] as never));
    source.add(RULE_SETS.escapeLimits, 'parameters', escapeRulesToParameters(rules['escapeRules'] as never));
    this.engine = new RuleEngine(source);
    return this.engine;
  }

  /** The server's assessment, as the real backend computes it (same package). */
  assess(app: Application) {
    const ref = this.bundle('reference') as Record<string, never>;
    return assess(app, this.ruleEngine(), {
      applicationTypes: ref['applicationTypes'],
      buildTypes: ref['buildTypes'],
      partyRoles: ref['partyRoles'],
      documentRequirements: ref['documentRequirements'],
      equipments: ref['equipments'],
    });
  }

  private save(app: Application): { application: Application; assessment: unknown } {
    const assessment = this.assess(app);
    app.row_version = (app.row_version ?? 0) + 1;
    app.last_modified = formatLegacyDate(this.now);
    const i = this.apps.findIndex((a) => a.appl_id === app.appl_id);
    if (i >= 0) this.apps[i] = app;
    else this.apps.push(app);
    return { application: app, assessment };
  }

  /** What the signed-in officer may do: every open task of his is fully actionable in the fake. */
  allowedActions(app: Application) {
    const me = this.sessionUser();
    const run = app.workflow;
    if (!me || !run || run.completed_on) {
      return { tasks: [], outcomes: [], skip: [], reassign: [], reassign_candidates: {}, upload_documents: false, sms: false, change_fire_station: false, update_licensing_authority: false, is_decider: false };
    }
    const current = oracle.currentTasks(run);
    const finalKey = run.stages.at(-1)!.key;
    const mine = current.filter((t) => t.state === 'active' && t.assignee === me.username);
    const isDecider = run.approver === me.username;
    const pending = current.filter((t) => (t.state === 'active' || t.state === 'waiting') && t.stage_key !== finalKey);
    const def = (t: { stage_key: string; task_key: string }) => oracle.taskDefOf(run.stages, t.stage_key, t.task_key);
    const overdue = oracle.isProcessingOverdue(app, this.sla, this.now);
    return {
      tasks: mine.map((t) => ({
        task_id: t.task_id,
        save: true,
        submit: t.stage_key !== finalKey,
        send_back: !!def(t)?.permissions.send_back,
        decide: t.stage_key === finalKey,
        request_documents: !!def(t)?.permissions.request_documents,
        challan_check: app.payment.mode === 'challan' && t.form === 'section_note',
      })),
      outcomes: mine.some((t) => t.stage_key === finalKey) ? (def(mine.find((t) => t.stage_key === finalKey)!)?.decision?.outcomes ?? []).filter((o) => !(overdue && o === 'return')) : [],
      skip: isDecider ? pending.filter((t) => def(t)?.permissions.skippable).map((t) => t.task_id) : [],
      reassign: isDecider ? pending.filter((t) => def(t)?.permissions.reassignable).map((t) => t.task_id) : [],
      reassign_candidates: Object.fromEntries(
        pending.map((t) => [t.task_id, this.officers().filter((o) => o.active && o.role_id === t.role_id).map((o) => ({ id: o.id, username: o.username, displayName: o.displayName }))]),
      ),
      upload_documents: mine.length > 0 || isDecider,
      sms: mine.length > 0 || isDecider,
      change_fire_station: (mine.length > 0 || isDecider) && app.status_id === 2 && !run.tasks.some((t) => t.state === 'done'),
      update_licensing_authority: (mine.length > 0 || isDecider) && oracle.activeStageIndex(run) === run.stages.length - 1,
      is_decider: isDecider,
    };
  }

  deptView(id: number) {
    const app = this.app(id);
    return { application: app, allowed_actions: this.allowedActions(app), parent: app.parent_id ? (this.apps.find((a) => a.appl_id === app.parent_id) ?? null) : null };
  }

  private summary(a: Application) {
    return { ...toSummary(a), stage_label: a.stage_label ?? '', days_idle: 0, fire_station_id: a.fire_station_id };
  }

  private page<T>(items: T[], query: Record<string, string>) {
    const pageSize = query['pageSize'] === 'all' ? 100_000 : Number(query['pageSize'] ?? 25);
    const page = Number(query['page'] ?? 1);
    return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize };
  }

  // ── routes ────────────────────────────────────────────────────────────────

  private define(): void {
    const id = (p: string[]) => Number(p[0]);

    // auth
    this.route('POST', /^\/auth\/login$/, ({ body }) => {
      const { username, password } = body as { username: string; password: string };
      const u = this.users.find((x) => x.username.toLowerCase() === username.toLowerCase() || x.email.toLowerCase() === username.toLowerCase());
      if (!u || password !== 'demo') throw new FakeApiError(401, 'Invalid username or password.');
      if (u.active === false) throw new FakeApiError(403, 'This account has been deactivated. Please contact the portal administrator.');
      return { user: { ...u, must_change_password: !!u.must_change_password }, accessToken: 'fake-token', expiresIn: 900, landing: `/${u.portal}/dashboard`, dataVersions: {} };
    });
    this.route('POST', /^\/auth\/refresh$/, () => {
      throw new FakeApiError(401, 'Your session has expired. Please sign in again.');
    });
    this.route('POST', /^\/auth\/logout$/, () => undefined);
    this.route('GET', /^\/auth\/me$/, () => {
      const u = this.sessionUser();
      if (!u) throw new FakeApiError(401, 'Please sign in to continue.');
      return { user: u };
    });
    this.route('POST', /^\/auth\/register$/, ({ body }) => {
      const b = body as { email: string; name: string; mobile: string };
      if (this.users.some((u) => u.email.toLowerCase() === b.email.toLowerCase())) throw new FakeApiError(409, 'An account with this e-mail already exists.');
      return { username: b.email.toLowerCase(), setPasswordUrl: 'http://localhost:4200/auth/reset-password?token=fake-token&welcome=1' };
    });
    this.route('POST', /^\/auth\/forgot-password$/, () => ({ accepted: true }));
    this.route('POST', /^\/auth\/reset-password$/, () => undefined);
    this.route('PUT', /^\/auth\/password$/, ({ body }) => {
      const b = body as { currentPassword: string };
      if (b.currentPassword !== 'demo') throw new FakeApiError(422, 'The current password is incorrect.');
      return null;
    });

    // cached reference data
    this.route('GET', /^\/meta\/versions$/, () => ({ reference: 1, rules: 1, content: 1, workflow: 1, directory: 1 }));
    this.route('GET', /^\/bundles\/(\w+)(?:\/v\/\d+)?$/, ({ params }) => this.bundle(params[0]));

    // configuration
    this.route('GET', /^\/config\/fees$/, () => this.feeConfig);
    this.route('GET', /^\/config\/delegation-rules$/, () => this.delegationRules);
    this.route('GET', /^\/config\/renewal-rules$/, () => this.renewalRules);
    this.route('PUT', /^\/config\/fees$/, ({ body }) => (this.feeConfig = body as Record<string, unknown>));
    this.route('PUT', /^\/config\/delegation-rules$/, ({ body }) => (this.delegationRules = body as unknown[]));
    this.route('PUT', /^\/config\/renewal-rules$/, ({ body }) => (this.renewalRules = body as unknown[]));
    this.route('GET', /^\/config\/workflows$/, () => this.workflows);
    this.route('GET', /^\/config\/workflows\/defaults$/, () => fixture<WorkflowDefinition[]>('assets/data/config/workflows.json').map((w, i) => ({ ...w, id: i + 1 })));
    this.route('GET', /^\/config\/workflows\/usage$/, () => {
      const usage: Record<string, Record<number, { total: number; inProcess: number }>> = {};
      for (const a of this.apps.filter((x) => x.workflow)) {
        const u = ((usage[a.workflow!.definition_code] ??= {})[a.workflow!.version] ??= { total: 0, inProcess: 0 });
        u.total++;
        if (!a.workflow!.completed_on) u.inProcess++;
      }
      return usage;
    });
    this.route('PUT', /^\/config\/workflows\/([\w-]+)$/, ({ params, body }) => {
      const i = this.workflows.findIndex((w) => w.code === params[0]);
      this.workflows[i] = { ...(body as WorkflowDefinition), version: this.workflows[i].version + 1 };
      return this.workflows[i];
    });
    this.route('GET', /^\/config\/forms$/, () => this.forms);
    this.route('GET', /^\/config\/sla$/, () => this.sla);
    this.route('PUT', /^\/config\/sla$/, ({ body }) => Object.assign(this.sla, body));
    this.route('GET', /^\/config\/statuses$/, () => this.statuses);

    // applications (citizen)
    this.route('GET', /^\/applications$/, ({ query }) => {
      const me = this.sessionUser();
      let list = this.apps;
      if (query['scope'] === 'mine') list = list.filter((a) => a.owner === me?.username);
      if (query['scope'] === 'dept') list = list.filter((a) => a.status_id > 1);
      if (query['draftsOnly'] === 'true') list = list.filter((a) => a.status_id === 1);
      if (query['type']) list = list.filter((a) => a.appl_type === query['type']);
      if (query['statusId']) list = list.filter((a) => a.status_id === Number(query['statusId']));
      if (query['text']) {
        const t = query['text'].toLowerCase();
        list = list.filter((a) => `${a.appl_number} ${a.site_name} ${a.build_name} ${a.dist_name} ${a.owner}`.toLowerCase().includes(t));
      }
      return this.page(list.map((a) => this.summary(a)), query);
    });
    this.route('GET', /^\/applications\/(\d+)$/, ({ params }) => {
      const a = this.app(id(params));
      const me = this.sessionUser();
      if (me?.portal === 'citizen' && a.owner !== me.username) throw new FakeApiError(404, 'Application not found.');
      return a;
    });
    this.route('GET', /^\/applications\/(\d+)\/revisions$/, () => []);
    this.route('GET', /^\/applications\/(\d+)\/fee$/, ({ params }) => {
      const a = this.app(id(params));
      const fee = this.assess(a).fee;
      const paid = a.payment.status === 'paid' ? a.payment.amount : 0;
      return { fee, paid, due: Math.max(0, fee.total - paid), frozen: paid > 0 };
    });
    this.route('POST', /^\/applications$/, ({ body }) => {
      const draft = clone(body as Application);
      if (!draft.site_name?.trim() || !draft.site_addr?.trim()) throw new FakeApiError(422, 'Please provide the Site Name and Site Address to save the application.');
      draft.appl_id = Math.max(...this.apps.map((a) => a.appl_id)) + 1;
      draft.status_id = 1;
      return this.save(draft);
    });
    this.route('PUT', /^\/applications\/(\d+)$/, ({ params, body, raw }) => {
      const current = this.app(id(params));
      const match = raw.headers.get('If-Match');
      if (match && match !== `"r${current.row_version}"`) {
        throw new FakeApiError(409, 'This application was changed elsewhere (another tab or device). Reload it to see the latest version before saving.');
      }
      return this.save({ ...clone(body as Application), appl_id: current.appl_id, status_id: current.status_id, row_version: current.row_version });
    });
    this.route('DELETE', /^\/applications\/(\d+)$/, ({ params }) => {
      this.apps.splice(
        this.apps.findIndex((a) => a.appl_id === id(params)),
        1,
      );
      return null;
    });
    this.route('POST', /^\/applications\/(\d+)\/payment$/, ({ params, body }) => {
      const a = this.app(id(params));
      const b = body as { mode: 'online' | 'challan'; challan_num?: string; challan_date?: string; bank?: string; branch?: string };
      const fee = this.assess(a).fee.total;
      a.payment = {
        ...a.payment,
        mode: b.mode,
        amount: fee,
        status: 'paid',
        txn_ref: b.mode === 'online' ? 'PAYU0000000001' : '',
        challan_num: b.challan_num ?? '',
        challan_date: b.challan_date ?? '',
        challan_bnk: b.bank ?? '',
        challan_brch: b.branch ?? '',
        paid_on: formatLegacyDate(this.now),
      };
      return { application: this.save(a).application, payment: { fee: { total: fee }, paid: fee, due: 0, frozen: true, charged: fee } };
    });
    this.route('POST', /^\/applications\/(\d+)\/submit$/, ({ params }) => {
      const a = this.app(id(params));
      if (a.status_id !== 1) throw new FakeApiError(422, 'Only draft applications can be submitted.');
      const issues = this.assess(a).issues.filter((i) => i.severity === 'error');
      if (issues.length) throw new FakeApiError(422, 'The application is incomplete.', issues.map((i) => ({ field: i.field, message: i.message })));
      a.status_id = 2;
      a.stage_label = 'Submitted';
      a.appl_number = a.appl_number || '20261100001'; // yyyymm + 5 digits (N-2)
      a.applied_date = formatLegacyDate(this.now);
      return this.save(a);
    });
    this.route('POST', /^\/applications\/(\d+)\/revise$/, ({ params }) => {
      const a = this.app(id(params));
      a.status_id = 1;
      a.revision += 1;
      a.declaration_accepted = false;
      return { application: this.save(a).application };
    });
    this.route('POST', /^\/applications\/(\d+)\/feedback$/, ({ params, body }) => {
      const a = this.app(id(params));
      const b = body as { rating: number; remarks: string };
      a.feedback = { rating: b.rating, remarks: b.remarks, rated_on: formatLegacyDate(this.now) };
      return { application: a };
    });
    this.route('POST', /^\/applications\/(\d+)\/(occupancy|renewal)$/, ({ params, body }) => {
      const parent = this.app(id(params));
      const next = Math.max(...this.apps.map((a) => a.appl_id)) + 1;
      const child =
        params[1] === 'occupancy'
          ? occupancyFromProvisional(parent, next, this.now, (body as { conditions?: never[] })?.conditions ?? [])
          : renewalFromOccupancy(parent, next, this.now);
      parent.child_id = next;
      return this.save(child);
    });
    this.route('POST', /^\/applications\/(\d+)\/documents$/, ({ params, body }) => {
      const a = this.app(id(params));
      const b = body as { code: string; file: { name: string; size: number } };
      a.documents = a.documents.filter((d) => d.code !== b.code);
      a.documents.push({ doc_id: a.documents.length + 100, code: b.code, file_name: b.file.name, category: b.code, uploaded_on: formatLegacyDate(this.now), size: b.file.size, file_id: `file-${b.code}` });
      return { application: a };
    });
    this.route('DELETE', /^\/applications\/(\d+)\/documents\/(\d+)$/, ({ params }) => {
      const a = this.app(id(params));
      a.documents = a.documents.filter((d) => d.doc_id !== Number(params[1]));
      return { application: a };
    });
    this.route('POST', /^\/applications\/(\d+)\/document-requests\/(\d+)\/response$/, ({ params, body }) => {
      const a = this.app(id(params));
      const b = body as { comment: string };
      a.deptfiles = a.deptfiles.map((f) => (f.fileid === Number(params[1]) ? { ...f, status: 'U' as const, citizen_comment: b.comment } : f));
      return { application: a };
    });
    this.route('POST', /^\/files\/([\w-]+)\/download-token$/, ({ params }) => ({ url: `/api/v1/files/download/${params[0]}`, expiresIn: 120 }));

    // department
    this.route('GET', /^\/dept\/tasks$/, ({ query }) => {
      const me = this.sessionUser();
      if (!me) return { items: [], total: 0, overdue: 0, groups: [] };
      const stations = new Map((fixture<{ stations: { id: number; name: string }[] }[]>('assets/data/lookups/fire-stations.json')).flatMap((g) => g.stations.map((s) => [s.id, s.name] as const)));
      const text = (query['text'] ?? '').toLowerCase();
      const all = myTasks(this.apps, me.username)
        .filter(({ app }) => !query['type'] || app.appl_type === query['type'])
        .filter(({ app }) => !query['level'] || app.delegation_level === query['level'])
        .filter(({ app }) => !text || `${app.appl_number} ${app.site_name} ${app.build_name} ${app.dist_name} ${app.site_addr}`.toLowerCase().includes(text))
        .map(({ app, task, action_label }) => {
          const days = oracle.taskDaysPending(task, this.now);
          const sla = oracle.taskSlaDays(app.workflow!, task, this.sla, this.forms);
          return { app: this.summary(app), task, action: action_label, days, sla, overdue: days > sla, station: stations.get(app.fire_station_id) ?? '' };
        });
      const groups = new Map<string, number>();
      for (const r of all) groups.set(r.task.name, (groups.get(r.task.name) ?? 0) + 1);
      return {
        items: all.slice(0, Number(query['limit'] ?? 200)),
        total: all.length,
        overdue: all.filter((r) => r.overdue).length,
        groups: [...groups.entries()].map(([name, count]) => ({ name, count })),
      };
    });
    this.route('GET', /^\/dept\/monitoring$/, ({ query }) => {
      const me = this.sessionUser();
      if (!me) return this.page([], query);
      let apps = monitoredApplications(this.apps, me, this.roles);
      const inProcess = apps.filter((a) => !a.workflow?.completed_on).length;
      if (query['includeDecided'] !== 'true') apps = apps.filter((a) => !a.workflow?.completed_on);
      if (query['type']) apps = apps.filter((a) => a.appl_type === query['type']);
      if (query['level']) apps = apps.filter((a) => a.delegation_level === query['level']);
      if (query['text']) apps = apps.filter((a) => `${a.appl_number} ${a.site_name} ${a.build_name} ${a.dist_name} ${a.site_addr}`.toLowerCase().includes(query['text'].toLowerCase()));
      const stages = new Map<string, number>();
      for (const a of apps) stages.set(a.stage_label || 'Submitted', (stages.get(a.stage_label || 'Submitted') ?? 0) + 1);
      if (query['stage']) apps = apps.filter((a) => (a.stage_label || 'Submitted') === query['stage']);
      const rows = apps.map((app) => ({
        app: this.summary(app),
        station: '',
        days: oracle.processingDays(app, this.now),
        sla: oracle.slaFor(app, this.sla)?.processing_days ?? null,
        overdue: oracle.isProcessingOverdue(app, this.sla, this.now),
        complete: !!app.workflow?.completed_on,
      }));
      return {
        ...this.page(rows, query),
        stages: [...stages.entries()].map(([label, count]) => ({ label, count })),
        kpis: { in_process: inProcess, processing_overdue: rows.filter((r) => r.overdue).length },
        decided: query['includeDecided'] === 'true' ? { window_months: null, total: rows.filter((r) => r.complete).length } : null,
      };
    });
    this.route('GET', /^\/dept\/feedback-summary$/, ({ query }) => feedbackSummary(this.apps, query['months'] ? Number(query['months']) : null, this.now));
    this.route('GET', /^\/dept\/applications\/(\d+)$/, ({ params }) => {
      const a = this.app(id(params));
      if (a.status_id <= 1) throw new FakeApiError(404, 'Application not found.');
      return this.deptView(a.appl_id);
    });
    for (const action of ['save', 'submit', 'send-back', 'skip', 'reassign', 'decide']) {
      this.route('POST', new RegExp(`^/dept/applications/(\\d+)/tasks/(\\d+)/${action}$`), ({ params }) => this.deptView(id(params)));
    }
    this.route('POST', /^\/dept\/applications\/(\d+)\/tasks\/(\d+)\/signed-copy$/, ({ body }) => {
      const f = (body as { file: { name: string; size: number } }).file;
      return { file_id: 'signed-file', file_name: f.name, size: f.size };
    });
    this.route('POST', /^\/dept\/applications\/(\d+)\/tasks\/(\d+)\/decision-preview$/, ({ params, body }) => {
      const b = body as { outcome: string; input: { remark: string } };
      return { application: oracle.decisionPreviewApp(this.app(id(params)), b.outcome as never, b.input as never, this.roles, { rules: this.renewalRules as never }, this.now) };
    });
    for (const action of ['document-requests', 'dept-documents', 'sms']) {
      this.route('POST', new RegExp(`^/dept/applications/(\\d+)/${action}$`), ({ params }) => this.deptView(id(params)));
    }
    this.route('PUT', /^\/dept\/applications\/(\d+)\/(fire-station|licensing-authority)$/, ({ params }) => this.deptView(id(params)));
    this.route('GET', /^\/dept\/reports\/(\w+)$/, ({ params, query }) => {
      if (query['format'] === 'csv') return new Blob([`report,${params[0]}\n`], { type: 'text/csv' });
      const districts = fixture<never[]>('assets/data/lookups/districts.json');
      const regions = fixture<never[]>('assets/data/lookups/regions.json');
      const f = { level: query['level'] ?? '', type: query['type'] ?? '', region: query['region'] ?? '', status: Number(query['status'] ?? 0), host: query['host'], from: query['from'], to: query['to'] } as never;
      switch (params[0]) {
        case 'pendency':
          return oracle.pendencyReport(this.apps, f, this.sla, this.now, regions);
        case 'statistics':
          return oracle.statisticsReport(this.apps, f, regions);
        case 'consolidated':
          return oracle.consolidatedReport(this.apps, f, districts, regions);
        case 'applications': {
          const rows = oracle.applicationsReport(this.apps, f, regions);
          return { rows, total: rows.length };
        }
        case 'overdue':
          return oracle.overdueReport(this.apps, f, this.sla, districts, this.now, regions);
        case 'sms':
          return oracle.smsReport(this.apps, f, {}, regions);
        case 'feedback':
          return oracle.feedbackReport(this.apps, f, regions);
        case 'challan':
          return oracle.challanReport(this.apps, f, districts, regions);
        case 'district':
          return oracle.districtReport(this.apps, f, districts, regions);
        default:
          return oracle.levelParticularsReport(this.apps, f, regions);
      }
    });

    // administration
    this.route('GET', /^\/admin\/accounts$/, ({ query }) => {
      let list = this.users.map((u) => ({ ...u, active: u.active !== false }));
      if (query['portal']) list = list.filter((u) => u.portal === query['portal']);
      if (query['active']) list = list.filter((u) => u.active === (query['active'] === 'true'));
      if (query['q']) list = list.filter((u) => `${u.displayName} ${u.username} ${u.email}`.toLowerCase().includes(query['q'].toLowerCase()));
      return this.page(list, { ...query, pageSize: query['pageSize'] ?? '100' });
    });
    this.route('GET', /^\/admin\/officers$/, () => this.officers());
    this.route('POST', /^\/admin\/accounts\/dept$/, ({ body }) => {
      const b = body as SeedUser;
      if (this.users.some((u) => u.username === b.username)) throw new FakeApiError(422, 'This username is already taken.');
      const account = { ...b, id: Math.max(...this.users.map((u) => u.id)) + 1, portal: 'dept' as const, active: true, created_on: formatLegacyDate(this.now), must_change_password: true };
      this.users.push(account);
      return { account, temporaryPassword: 'Temp#Pass2026' };
    });
    this.route('PUT', /^\/admin\/accounts\/(\d+)\/(dept|profile)$/, ({ params, body }) => {
      const u = this.account(id(params));
      Object.assign(u, body);
      return { account: u };
    });
    this.route('POST', /^\/admin\/accounts\/(\d+)\/password$/, ({ params, body }) => {
      const u = this.account(id(params));
      u.must_change_password = true;
      return (body as { password?: string })?.password ? { account: u } : { account: u, temporaryPassword: 'Temp#Pass2026' };
    });
    this.route('PUT', /^\/admin\/accounts\/(\d+)\/active$/, ({ params, body }) => {
      const u = this.account(id(params));
      u.active = (body as { active: boolean }).active;
      return { account: u };
    });
    this.route('GET', /^\/admin\/accounts\/(\d+)\/open-tasks$/, ({ params }) => {
      const u = this.account(id(params));
      return {
        items: this.apps.flatMap((a) =>
          a.workflow && !a.workflow.completed_on
            ? oracle
                .currentTasks(a.workflow)
                .filter((t) => t.assignee === u.username && ['active', 'waiting', 'not_required'].includes(t.state))
                .map((t) => ({ appl_id: a.appl_id, appl_number: a.appl_number, site_name: a.site_name, task: { task_id: t.task_id, name: t.name, state: t.state, role_id: t.role_id, stage_key: t.stage_key } }))
            : [],
        ),
      };
    });
    this.route('POST', /^\/admin\/accounts\/(\d+)\/handover$/, () => ({ moved: 1, applications: 1 }));
    this.route('GET', /^\/admin\/unassigned-tasks$/, () => ({ items: [] }));
    this.route('POST', /^\/admin\/applications\/(\d+)\/tasks\/(\d+)\/reassign$/, ({ params }) => ({ application: this.app(id(params)) }));
    this.route('DELETE', /^\/admin\/applications$/, ({ body }) => {
      const ids = new Set((body as { ids: number[] }).ids);
      const kept = this.apps.filter((a) => ids.has(a.appl_id) && (a.status_id !== 1 || !!a.appl_number));
      if (kept.length) throw new FakeApiError(422, 'Submitted applications cannot be deleted.');
      const before = this.apps.length;
      for (let i = this.apps.length - 1; i >= 0; i--) if (ids.has(this.apps[i].appl_id)) this.apps.splice(i, 1);
      return { deleted: before - this.apps.length };
    });
    const statusRows = () =>
      this.statuses.map((s) => ({
        ...s,
        used_by: {
          applications: this.apps.filter((a) => a.status_id === s.code).length,
          history: 0,
          workflows: this.workflows.filter((w) => w.stages.some((st) => st.citizen_status === s.code)).length,
        },
      }));
    this.route('GET', /^\/admin\/statuses$/, () => ({ items: statusRows() }));
    this.route('POST', /^\/admin\/statuses$/, ({ body }) => {
      const b = body as { desc: string; sort_order?: number };
      this.statuses.push({ code: 10, desc: b.desc, category: 'in_process', badge: 'REV', is_system: false, is_pre_decision: false, sort_order: b.sort_order ?? 65, active: true });
      return { items: statusRows() };
    });
    this.route('PUT', /^\/admin\/statuses\/(\d+)$/, ({ params, body }) => {
      const s = this.statuses.find((x) => x.code === id(params))!;
      if (s.is_system) throw new FakeApiError(422, 'Statuses 1, 2, 7, 8 and 9 are system statuses and cannot be changed.');
      Object.assign(s, body);
      return { items: statusRows() };
    });
    this.route('DELETE', /^\/admin\/statuses\/(\d+)$/, ({ params }) => {
      this.statuses = this.statuses.filter((x) => x.code !== id(params));
      return { items: statusRows() };
    });
    const due = () => oracle.dueEscalations(oracle.overdueItems(this.apps, this.sla, this.forms, this.users, this.now), this.escalationLog, this.sla, this.now);
    this.route('GET', /^\/admin\/escalations\/preview$/, () => {
      const overdue = oracle.overdueItems(this.apps, this.sla, this.forms, this.users, this.now);
      const now = due();
      return { overdue, due: now, counts: { overdue: overdue.length, due: now.length }, last: this.escalationLog.at(-1) ?? null };
    });
    this.route('POST', /^\/admin\/escalations\/send$/, () => {
      const entry = oracle.escalationEntry(due(), this.now);
      if (entry.notices.length) this.escalationLog.push(entry);
      return entry;
    });
    this.route('GET', /^\/audit$/, ({ query }) => {
      const items = this.audit
        .filter((e) => !query['action'] || e.action.startsWith(query['action']))
        .filter((e) => !query['entityType'] || e.entityType === query['entityType'])
        .filter((e) => !query['entityId'] || e.entityId === query['entityId']);
      const page = Number(query['page'] ?? 1);
      const size = Number(query['pageSize'] ?? 50);
      return { items: items.slice((page - 1) * size, page * size), page, pageSize: size, more: items.length > page * size };
    });
    this.route('GET', /^\/admin\/escalations\/log$/, () => ({ items: [...this.escalationLog].reverse() }));
  }
}

export function fakeApiInterceptor(api: FakeApi): HttpInterceptorFn {
  return (req) => api.handle(req);
}

/** Providers for a TestBed: HttpClient answered by a fresh FakeApi (inject it to inspect / override). */
export function provideFakeApi(configure?: (api: FakeApi) => void): (Provider | EnvironmentProviders)[] {
  const api = new FakeApi();
  configure?.(api);
  return [provideHttpClient(withInterceptors([fakeApiInterceptor(api)])), { provide: FakeApi, useValue: api }];
}
