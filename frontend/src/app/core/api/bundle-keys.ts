import type { BundleName } from './data-version.bus';

/**
 * Where each read-only catalogue entry lives inside a cached bundle.
 * The catalogue stays the list of operations; this is the lookup table the
 * cached client uses instead of issuing one HTTP call per lookup.
 */
export interface BundleKey {
  bundle: BundleName;
  key: string | ((params: Record<string, string | number>) => string);
}

export const BUNDLE_KEYS: Record<string, BundleKey> = {
  lookupApplicationTypes: { bundle: 'reference', key: 'applicationTypes' },
  lookupBuildTypes: { bundle: 'reference', key: 'buildTypes' },
  lookupDirections: { bundle: 'reference', key: 'directions' },
  lookupDistricts: { bundle: 'reference', key: 'districts' },
  lookupFireStations: { bundle: 'reference', key: 'fireStations' },
  lookupHazards: { bundle: 'reference', key: 'hazards' },
  lookupMappedCodes: { bundle: 'reference', key: 'mappedCodes' },
  lookupEquipments: { bundle: 'reference', key: 'equipments' },
  lookupFfeNotes: { bundle: 'reference', key: 'ffeNotes' },
  lookupStatuses: { bundle: 'reference', key: 'statuses' },
  lookupDeptRoles: { bundle: 'reference', key: 'deptRoles' },
  lookupRegions: { bundle: 'reference', key: 'regions' },
  lookupPartyRoles: { bundle: 'reference', key: 'partyRoles' },
  lookupBlockOptions: { bundle: 'reference', key: 'blockOptions' },
  lookupDocumentRequirements: { bundle: 'reference', key: 'documentRequirements' },
  lookupOccupancyConditions: { bundle: 'reference', key: 'occupancyConditions' },
  lookupUndertakings: { bundle: 'reference', key: 'undertakings' },
  lookupEscapeRules: { bundle: 'rules', key: 'escapeRules' },
  lookupNocTerms: { bundle: 'content', key: 'nocTerms' },
  lookupNbcTable7: { bundle: 'content', key: 'nbcTable7' },
  rulesFfeEquipment: { bundle: 'rules', key: (p) => `ffe.${p['id']}` },
  rulesFfeType: { bundle: 'rules', key: 'ffeType' },
  rulesOtherNotes: { bundle: 'rules', key: 'otherNotes' },
  rulesRiserWidth: { bundle: 'rules', key: 'riserWidth' },
  rulesHeightLimits: { bundle: 'rules', key: 'heightLimits' },
  configFees: { bundle: 'rules', key: 'feeConfig' },
  configDelegationRules: { bundle: 'rules', key: 'delegationRules' },
  configRenewalRules: { bundle: 'rules', key: 'renewalRules' },
  configWorkflows: { bundle: 'workflow', key: 'workflows' },
  configForms: { bundle: 'workflow', key: 'forms' },
  configSla: { bundle: 'workflow', key: 'sla' },
};
