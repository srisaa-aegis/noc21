/**
 * Seed inputs: the JSON files under backend/seed/data (a copy of the portal's
 * fixtures) plus the recorded corrections applied to them.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../../config/env.js';
import type {
  Application,
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
  FormDef,
  Hazard,
  HtmlReference,
  MappedCode,
  NocTerms,
  OccupancyCondition,
  PartyRole,
  Region,
  RenewalRule,
  RuleTree,
  SlaConfig,
  StatusCode,
  Undertakings,
  UserAccount,
  WorkflowDefinition,
} from '@srisaa/noc-domain';

export const SEED_DIR = resolve(config().repoRoot, 'backend', 'seed');
const DATA = resolve(SEED_DIR, 'data');

export function readSeed<T>(relative: string): T {
  return JSON.parse(readFileSync(resolve(DATA, relative), 'utf8')) as T;
}

export interface Corrections {
  fireStations: { drop: { legacyId: string; name: string; district: number; reason: string; applied?: string }[] };
}

/** The recorded data corrections (already applied to the JSON inputs; listed by the seeder). */
export const corrections = JSON.parse(readFileSync(resolve(SEED_DIR, 'corrections.json'), 'utf8')) as Corrections;

/** A seed user: the API shape plus the fields only the seed carries. */
export type SeedUser = UserAccount & { aadhar?: string };

export const seedInputs = {
  regions: () => readSeed<Region[]>('lookups/regions.json'),
  districts: () => readSeed<District[]>('lookups/districts.json'),
  fireStations: () => readSeed<DistrictFireStations[]>('lookups/fire-stations.json'),
  applicationTypes: () => readSeed<ApplicationType[]>('lookups/application-types.json'),
  buildTypes: () => readSeed<BuildType[]>('lookups/build-types.json'),
  directions: () => readSeed<Direction[]>('lookups/directions.json'),
  hazards: () => readSeed<Hazard[]>('lookups/hazards.json'),
  mappedCodes: () => readSeed<MappedCode[]>('lookups/mapped-codes.json'),
  equipments: () => readSeed<Equipment[]>('lookups/equipments.json'),
  ffeNotes: () => readSeed<FfeNotes>('lookups/ffe-notes.json'),
  statuses: () => readSeed<StatusCode[]>('lookups/statuses.json'),
  deptRoles: () => readSeed<DeptRole[]>('lookups/dept-roles.json'),
  partyRoles: () => readSeed<PartyRole[]>('lookups/party-roles.json'),
  blockOptions: () => readSeed<BlockOptions>('lookups/block-options.json'),
  documentRequirements: () => readSeed<DocumentRequirements>('lookups/document-requirements.json'),
  occupancyConditions: () => readSeed<OccupancyCondition[]>('lookups/occupancy-conditions.json'),
  undertakings: () => readSeed<Undertakings>('lookups/undertakings.json'),
  nocTerms: () => readSeed<NocTerms>('lookups/noc-terms.json'),
  nbcTable7: () => readSeed<HtmlReference>('lookups/nbc-table7.json'),
  escapeRules: () => readSeed<EscapeRules>('lookups/escape-rules.json'),
  feeConfig: () => readSeed<FeeConfig>('config/fee-config.json'),
  delegationRules: () => readSeed<DelegationRule[]>('config/delegation-rules.json'),
  renewalRules: () => readSeed<RenewalRule[]>('config/renewal-rules.json'),
  workflows: () => readSeed<WorkflowDefinition[]>('config/workflows.json'),
  forms: () => readSeed<FormDef[]>('config/forms.json'),
  sla: () => readSeed<SlaConfig>('config/sla.json'),
  users: () => readSeed<SeedUser[]>('auth/users.json'),
  applications: () => readSeed<Application[]>('applications/applications.json'),
  ffeTrees: (): { id: number; tree: RuleTree }[] =>
    readdirSync(resolve(DATA, 'rules', 'ffe'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ id: Number(f.replace('.json', '')), tree: readSeed<RuleTree>(`rules/ffe/${f}`) }))
      .sort((a, b) => a.id - b.id),
  ffeType: () => readSeed<RuleTree>('rules/ffe-type.json'),
  otherNotes: () => readSeed<RuleTree>('rules/other-notes.json'),
  riserWidth: () => readSeed<RuleTree>('rules/riser-width.json'),
  heightLimits: () => readSeed<RuleTree>('rules/height-limits.json'),
};

/** Checksum of every seed input, recorded in seed_state so changes are visible. */
export function seedChecksum(): string {
  const hash = createHash('sha256');
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else hash.update(readFileSync(full));
    }
  };
  walk(DATA);
  hash.update(readFileSync(resolve(SEED_DIR, 'corrections.json')));
  return hash.digest('hex').slice(0, 32);
}

/** Fire station id of the seed data (0 / missing = none). */
export function stationId(id: number | null | undefined): number | null {
  return id ? Number(id) : null;
}
