import { Application, DocumentRequirements } from './models/index.js';

export interface RequiredDocument {
  code: string;
  label: string;
  optional: boolean;
  group: 'general' | 'plans';
  blockName?: string;
  /** Block the plan belongs to (plans are uploaded in the block's own flow). */
  blockId?: number;
}

/**
 * Resolves which documents/plans an application needs, from
 * lookups/document-requirements.json (mirrors the ng-if conditions in the
 * legacy editpnoc/editonoc/editrnoc/editdnoc upload sections).
 */
export function requiredDocuments(app: Application, reqs: DocumentRequirements): RequiredDocument[] {
  const list: RequiredDocument[] = [];
  const general = reqs[app.appl_type] ?? [];
  for (const r of general) {
    let applies: boolean;
    switch (r.condition) {
      case 'always':
        applies = true;
        break;
      case 'challan':
        applies = app.payment.mode === 'challan';
        break;
      case 'not_dfo':
        applies = app.delegation_level !== 'DFO';
        break;
      case 'road_widening':
        applies = app.blocks.some((b) => !!b.road_wide);
        break;
      case 'has_parent':
        applies = app.parent_id > 0;
        break;
    }
    if (applies) {
      list.push({ code: r.code, label: r.label, optional: !!r.optional, group: 'general' });
    }
  }
  if (reqs.plans.applies_to.includes(app.appl_type)) {
    for (const block of app.blocks) {
      for (const p of reqs.plans.block) {
        list.push({ code: `${p.code}:${block.block_id}`, label: p.label, optional: false, group: 'plans', blockName: block.block_name, blockId: block.block_id });
      }
      for (const floor of block.floors) {
        list.push({
          code: `${reqs.plans.floor.code}:${block.block_id}:${floor.floor_id}`,
          label: `${reqs.plans.floor.label} — ${floor.flr_name || 'Floor ' + floor.floor_id}`,
          optional: false,
          group: 'plans',
          blockName: block.block_name,
          blockId: block.block_id,
        });
      }
    }
  }
  return list;
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Legacy rule: only PDF documents are accepted. Returns an error message or null. */
export function validateUpload(file: { name: string; size: number; type?: string }): string | null {
  const isPdf = file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';
  if (!isPdf) {
    return 'Only PDF files are accepted.';
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return 'File is larger than 10 MB.';
  }
  return null;
}
