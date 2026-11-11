import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { ApiClient } from '../api/api-client.service';
import { API_ENDPOINTS } from '../api/api-endpoints';
import { PortalRole, UserAccount } from '../models';

export type CitizenProfilePatch = Pick<UserAccount, 'displayName' | 'email' | 'mobile'> & Partial<Pick<UserAccount, 'address' | 'gender' | 'dob'>>;

export interface DeptUserInput {
  username?: string;
  displayName: string;
  email: string;
  mobile: string;
  role_id: number;
  district?: number;
  /** Fire stations the officer is associated with (ignored when `all_stations`). */
  fire_station_ids?: number[];
  all_stations?: boolean;
}

export interface PasswordIssued {
  account: UserAccount;
  /** Shown once to the administrator; the officer must change it at the first sign-in. */
  temporaryPassword?: string;
}

export interface AccountPage {
  items: UserAccount[];
  total: number;
  page: number;
  pageSize: number;
}

export interface OpenTask {
  appl_id: number;
  appl_number: string;
  site_name: string;
  task: { task_id: number; name: string; state: string; role_id: number; stage_key: string };
}

/** Administration of the login accounts (Admin → Citizens, Admin → Dept Users). */
@Injectable({ providedIn: 'root' })
export class AccountsService {
  private readonly api = inject(ApiClient);

  /** One page of accounts; the server searches name, username and e-mail. */
  page(query: { portal?: PortalRole; q?: string; active?: boolean; page?: number; pageSize?: number } = {}): Observable<AccountPage> {
    return this.api.get<AccountPage>(API_ENDPOINTS.adminAccounts, undefined, {
      portal: query.portal,
      q: query.q,
      active: query.active === undefined ? undefined : String(query.active),
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 100,
    });
  }

  /** Every account of a portal (department users and admins are few). */
  list(portal?: PortalRole): Observable<UserAccount[]> {
    return this.page({ portal, pageSize: 500 }).pipe(map((p) => p.items));
  }

  updateCitizen(id: number, patch: CitizenProfilePatch): Observable<UserAccount> {
    return this.api.request<{ account: UserAccount }>(API_ENDPOINTS.adminCitizenUpdate, { params: { id }, body: patch }).pipe(map((r) => r.account));
  }

  /** The administrator sets a password (or, without one, issues a temporary password); it must be changed at the next sign-in. */
  setPassword(id: number, password?: string): Observable<PasswordIssued> {
    return this.api.request<PasswordIssued>(API_ENDPOINTS.adminSetPassword, { params: { id }, body: password ? { password } : {} });
  }

  setActive(id: number, active: boolean): Observable<UserAccount> {
    return this.api.request<{ account: UserAccount }>(API_ENDPOINTS.adminAccountSetActive, { params: { id }, body: { active } }).pipe(map((r) => r.account));
  }

  createDeptUser(input: DeptUserInput): Observable<PasswordIssued> {
    return this.api.request<PasswordIssued>(API_ENDPOINTS.adminDeptUserCreate, { body: input });
  }

  updateDeptUser(id: number, input: DeptUserInput): Observable<UserAccount> {
    return this.api.request<{ account: UserAccount }>(API_ENDPOINTS.adminDeptUserUpdate, { params: { id }, body: input }).pipe(map((r) => r.account));
  }

  openTasks(id: number): Observable<OpenTask[]> {
    return this.api.get<{ items: OpenTask[] }>(API_ENDPOINTS.adminOpenTasks, { id }).pipe(map((r) => r.items));
  }

  /** Moves every pending task of an officer to another officer of the same role. */
  handOver(fromId: number, toId: number): Observable<{ moved: number; applications: number }> {
    return this.api.request(API_ENDPOINTS.adminHandover, { params: { id: fromId }, body: { to: toId } });
  }
}
