import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ApiClient } from './api-client.service';
import { ALL_API_ENDPOINTS, API_ENDPOINTS } from './api-endpoints';
import { ApiError } from './http-backend.service';
import { DataVersionBus } from './data-version.bus';

describe('ApiClient (the one data-access service)', () => {
  let api: ApiClient;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(ApiClient);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('resolves a catalogue entry to its REST route', () => {
    expect(api.url(API_ENDPOINTS.lookupDistricts)).toBe('/api/v1/lookups/districts');
    expect(api.url(API_ENDPOINTS.rulesFfeEquipment, { id: 7 })).toBe('/api/v1/rules/ffe/7');
    expect(api.url(API_ENDPOINTS.deptTaskSubmit, { id: 12, taskNo: 3 })).toBe('/api/v1/dept/applications/12/tasks/3/submit');
    expect(() => api.url(API_ENDPOINTS.deptTaskSubmit, { id: 12 })).toThrow(/Missing parameter/);
  });

  it('keeps the catalogue consistent: unique ids, absolute paths, no /portal transition routes', () => {
    const ids = ALL_API_ENDPOINTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of ALL_API_ENDPOINTS) {
      expect(e.path.startsWith('/'), e.id).toBe(true);
      expect(e.path, e.id).not.toMatch(/^\/portal\//);
    }
  });

  it('sends the method, the query and the body of the endpoint', async () => {
    const promise = new Promise((resolve) =>
      api.request(API_ENDPOINTS.deptSendBack, { params: { id: 5, taskNo: 2 }, body: { comments: 'recheck' } }).subscribe(resolve),
    );
    const req = http.expectOne('/api/v1/dept/applications/5/tasks/2/send-back');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ comments: 'recheck' });
    req.flush({ ok: true });
    await expect(promise).resolves.toEqual({ ok: true });

    api.get(API_ENDPOINTS.deptMonitoring, undefined, { text: 'padma', page: 2, empty: '', none: undefined }).subscribe();
    const list = http.expectOne((r) => r.url === '/api/v1/dept/monitoring');
    expect(list.request.params.get('text')).toBe('padma');
    expect(list.request.params.get('page')).toBe('2');
    expect(list.request.params.has('empty')).toBe(false);
    list.flush({});
  });

  it('reports a clear message when the server cannot be reached', async () => {
    const promise = new Promise<ApiError>((resolve) => api.get(API_ENDPOINTS.lookupDistricts).subscribe({ error: resolve }));
    http.expectOne('/api/v1/lookups/districts').error(new ProgressEvent('error'), { status: 0 });
    const error = await promise;
    expect(error.status).toBe(0);
    expect(error.message).toContain('cannot reach the server');
  });

  it('uses `detail` as the message the portal shows, and keeps the field issues', async () => {
    const promise = new Promise<ApiError>((resolve) => api.get(API_ENDPOINTS.lookupDistricts).subscribe({ error: resolve }));
    http.expectOne('/api/v1/lookups/districts').flush(
      {
        type: 'https://noc.portal/errors/business-rule',
        title: 'Cannot be processed',
        status: 422,
        detail: 'Only draft applications can be edited.',
        requestId: 'abc',
        errors: [{ field: 'site_name', message: 'Enter the site name.', severity: 'error' }],
      },
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    const error = await promise;
    expect(error.message).toBe('Only draft applications can be edited.');
    expect(error.status).toBe(422);
    expect(error.issues?.[0].field).toBe('site_name');
    expect(error.requestId).toBe('abc');
  });
});

describe('DataVersionBus', () => {
  it('parses the X-Data-Versions header', () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const bus = TestBed.inject(DataVersionBus);
    bus.observe('reference=12;rules=5;content=2;workflow=7;directory=3');
    expect(bus.serverVersions()).toEqual({ reference: 12, rules: 5, content: 2, workflow: 7, directory: 3 });
  });

  it('ignores unknown bundles and only updates on a change', () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const bus = TestBed.inject(DataVersionBus);
    bus.observe('reference=1;nonsense=9');
    const first = bus.serverVersions();
    bus.observe('reference=1');
    expect(bus.serverVersions()).toBe(first);
    bus.observe('reference=2');
    expect(bus.serverVersions().reference).toBe(2);
  });
});
