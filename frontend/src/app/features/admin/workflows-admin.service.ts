import { Injectable, inject } from '@angular/core';
import { Observable, forkJoin, map, take } from 'rxjs';
import { ApiClient } from '../../core/api/api-client.service';
import { API_ENDPOINTS } from '../../core/api/api-endpoints';
import { LookupService } from '../../core/lookups/lookup.service';
import {
  DeptRole,
  District,
  DistrictFireStations,
  FormDef,
  Region,
  SlaConfig,
  StatusCode,
  UserAccount,
  WorkflowDefinition,
} from '../../core/models';

export interface WorkflowAdminData {
  workflows: WorkflowDefinition[];
  defaults: WorkflowDefinition[];
  sla: SlaConfig;
  forms: FormDef[];
  roles: DeptRole[];
  regions: Region[];
  /** Department officers (for the simulator). */
  users: UserAccount[];
  districts: District[];
  fireStations: DistrictFireStations[];
  statuses: StatusCode[];
  /** Applications per workflow code → version → count (current runs only). */
  usage: Record<string, Record<number, { total: number; inProcess: number }>>;
}

/** Admin → Workflows and Admin → SLA & Escalations (saved on the server as new versions). */
@Injectable({ providedIn: 'root' })
export class WorkflowsAdminService {
  private readonly api = inject(ApiClient);
  private readonly lookups = inject(LookupService);

  load(): Observable<WorkflowAdminData> {
    return forkJoin({
      workflows: this.api.get<WorkflowDefinition[]>(API_ENDPOINTS.configWorkflows),
      defaults: this.api.get<WorkflowDefinition[]>(API_ENDPOINTS.configWorkflowsDefault),
      sla: this.api.get<SlaConfig>(API_ENDPOINTS.configSla),
      forms: this.lookups.forms$.pipe(take(1)),
      roles: this.lookups.deptRoles$.pipe(take(1)),
      regions: this.lookups.regions$.pipe(take(1)),
      districts: this.lookups.districts$.pipe(take(1)),
      fireStations: this.lookups.fireStations$.pipe(take(1)),
      statuses: this.lookups.statuses$.pipe(take(1)),
      users: this.api
        .get<(UserAccount & { role_id: number })[]>(API_ENDPOINTS.adminOfficers)
        .pipe(map((list) => list.map((o) => ({ ...o, portal: 'dept' as const })))),
      usage: this.api.get<WorkflowAdminData['usage']>(API_ENDPOINTS.workflowUsage),
    });
  }

  /**
   * Saves one workflow as a new version (the server validates it and the whole set).
   * Applications already in process keep the version they started with.
   */
  save(def: WorkflowDefinition): Observable<WorkflowDefinition> {
    return this.api.request<WorkflowDefinition>(API_ENDPOINTS.adminSaveWorkflow, { params: { code: def.code }, body: def });
  }

  saveSla(sla: SlaConfig): Observable<SlaConfig> {
    return this.api.request<SlaConfig>(API_ENDPOINTS.adminSaveSla, { body: sla });
  }
}
