import { Injectable, inject } from '@angular/core';
import { Observable, defer, forkJoin, throwError } from 'rxjs';
import { ApiClient } from '../../core/api/api-client.service';
import { API_ENDPOINTS } from '../../core/api/api-endpoints';
import { delegationRuleProblems, feeConfigProblems, renewalRuleProblems } from '../../core/domain/config-rules';
import { RulesConfig } from '../../core/lookups/lookup.service';
import { DelegationRule, FeeConfig, RenewalRule } from '../../core/models';

/**
 * Admin maintenance of the configurable rules (fees, approval levels, renewal periods).
 * Each save publishes a new immutable rule-set version on the server; a fee already paid stays
 * frozen with the version it was paid under (Q-57).
 */
@Injectable({ providedIn: 'root' })
export class RulesConfigService {
  private readonly api = inject(ApiClient);

  /** Always read from the server (not the cache) so the page shows what is published now. */
  load(): Observable<RulesConfig> {
    return forkJoin({
      feeConfig: this.api.get<FeeConfig>(API_ENDPOINTS.configFees),
      delegationRules: this.api.get<DelegationRule[]>(API_ENDPOINTS.configDelegationRules),
      renewalRules: this.api.get<RenewalRule[]>(API_ENDPOINTS.configRenewalRules),
    });
  }

  private checked<T>(problems: string[], save: () => Observable<T>): Observable<T> {
    return problems.length ? throwError(() => new Error(problems.join(' '))) : defer(save);
  }

  saveFees(config: FeeConfig): Observable<FeeConfig> {
    return this.checked(feeConfigProblems(config), () => this.api.request<FeeConfig>(API_ENDPOINTS.adminSaveFees, { body: config }));
  }

  saveDelegationRules(rules: DelegationRule[]): Observable<DelegationRule[]> {
    return this.checked(delegationRuleProblems(rules), () => this.api.request<DelegationRule[]>(API_ENDPOINTS.adminSaveDelegationRules, { body: rules }));
  }

  saveRenewalRules(rules: RenewalRule[]): Observable<RenewalRule[]> {
    return this.checked(renewalRuleProblems(rules), () => this.api.request<RenewalRule[]>(API_ENDPOINTS.adminSaveRenewalRules, { body: rules }));
  }
}
