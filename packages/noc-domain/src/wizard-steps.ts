import { ApplicationTypeCode } from './models/index.js';

/**
 * Pages of the application form. Like the legacy app (editpnoc.html with its block list, then
 * editpnoc_1 / _2 / _3 for ONE block at a time), the form has application-level pages and, under
 * "Blocks", a separate flow per block that collects all the information of that block.
 */
export type WizardStepId = 'basic' | 'blocks' | 'documents' | 'submit';

/** Pages of the per-block flow (legacy editpnoc_1 = details + floors, editpnoc_2 = escapes, editpnoc_3 = FFE, editpnoc_4 = plans). */
export type BlockStepId = 'details' | 'floors' | 'escapes' | 'ffe' | 'plans';

export interface WizardStep {
  id: WizardStepId;
  label: string;
  description: string;
}

export interface BlockStep {
  id: BlockStepId;
  label: string;
  description: string;
}

/** A place in the form (used by "Go to page" links). */
export interface WizardTarget {
  step: WizardStepId;
  blockId?: number;
  blockStep?: BlockStepId;
}

const STEP_META: Record<WizardStepId, WizardStep> = {
  basic: { id: 'basic', label: 'Application', description: 'Site, licensing authority, builder & technical parties' },
  blocks: { id: 'blocks', label: 'Blocks', description: 'Each building: details, floors, means of escape, fire safety' },
  documents: { id: 'documents', label: 'Documents', description: 'Supporting documents (PDF)' },
  submit: { id: 'submit', label: 'Fee & Submit', description: 'Fee payment, verification and submission' },
};

export const BLOCK_STEPS: BlockStep[] = [
  { id: 'details', label: 'Block Details', description: 'Occupancy, height, surroundings, open spaces' },
  { id: 'floors', label: 'Floors', description: 'Floor-wise area, occupancy and occupants' },
  { id: 'escapes', label: 'Means of Escape', description: 'Staircases, travel distance, doors, exits, refuge, lifts' },
  { id: 'ffe', label: 'Fire Fighting Equipment', description: 'Floor-wise and building fire safety systems' },
  { id: 'plans', label: 'Plans', description: 'Site, section, elevation and floor plans (PDF)' },
];

const STEPS_BY_TYPE: Record<ApplicationTypeCode, WizardStepId[]> = {
  P: ['basic', 'blocks', 'documents', 'submit'],
  O: ['basic', 'blocks', 'documents', 'submit'],
  R: ['basic', 'blocks', 'documents', 'submit'],
  RO: ['basic', 'blocks', 'documents', 'submit'],
  D: ['basic', 'documents', 'submit'],
};

const DESCRIPTION_OVERRIDES: Partial<Record<ApplicationTypeCode, Partial<Record<WizardStepId, string>>>> = {
  D: { basic: 'Occupancy NOC reference, site and owner details', documents: 'Signed self-declaration and supporting documents' },
  R: { basic: 'Occupancy NOC reference, site, owner & technical parties' },
};

export function stepsFor(type: ApplicationTypeCode): WizardStep[] {
  return STEPS_BY_TYPE[type].map((id) => ({
    ...STEP_META[id],
    description: DESCRIPTION_OVERRIDES[type]?.[id] ?? STEP_META[id].description,
  }));
}

export function isBlockStep(value: string | undefined): value is BlockStepId {
  return BLOCK_STEPS.some((s) => s.id === value);
}
