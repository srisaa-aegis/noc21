import { ApplicationTypeCode, StatusCode, StatusId } from '../core/models';

export interface StatusPresentation {
  label: string;
  className: string;
}

/** Badge code of a status (statuses.badge) → CSS class of the chip. */
const BADGE_CLASS: Record<string, string> = {
  DRF: 'status--draft',
  SUB: 'status--submitted',
  INS: 'status--inspected',
  REV: 'status--review',
  PFA: 'status--pending',
  ISS: 'status--approved',
  RET: 'status--returned',
  REJ: 'status--rejected',
};

/**
 * The statuses as configured on the server (names, badges — decision N-4),
 * registered when the reference data loads. Until then the built-in names of
 * the system statuses are used.
 */
const catalog = new Map<number, StatusPresentation>();

export function registerStatuses(statuses: StatusCode[]): void {
  catalog.clear();
  for (const s of statuses) catalog.set(s.code, { label: s.desc, className: BADGE_CLASS[s.badge ?? ''] ?? FALLBACK[s.code as StatusId]?.className ?? 'status--review' });
}

const FALLBACK: Record<StatusId, StatusPresentation> = {
  1: { label: 'Draft', className: 'status--draft' },
  2: { label: 'Submitted', className: 'status--submitted' },
  3: { label: 'Inspected', className: 'status--inspected' },
  4: { label: 'Reviewed (ADFS)', className: 'status--review' },
  5: { label: 'Reviewed (DFS-CD)', className: 'status--review' },
  6: { label: 'Pending Final Approval', className: 'status--pending' },
  7: { label: 'Approved', className: 'status--approved' },
  8: { label: 'Returned with Comments', className: 'status--returned' },
  9: { label: 'Rejected', className: 'status--rejected' },
};

export function statusPresentation(statusId: StatusId | number): StatusPresentation {
  return catalog.get(statusId) ?? FALLBACK[statusId as StatusId] ?? { label: `Status ${statusId}`, className: 'status--review' };
}

export interface ApplTypePresentation {
  label: string;
  icon: string;
}

const APPL_TYPE_PRESENTATION: Record<ApplicationTypeCode, ApplTypePresentation> = {
  P: { label: 'Provisional', icon: 'clipboard-list' },
  O: { label: 'Occupancy', icon: 'login' },
  R: { label: 'Renewal', icon: 'repeat' },
  RO: { label: 'Occupancy Renewal', icon: 'repeat' },
  D: { label: 'Declaration', icon: 'save' },
};

export function applTypePresentation(applType: ApplicationTypeCode): ApplTypePresentation {
  return APPL_TYPE_PRESENTATION[applType] ?? { label: applType, icon: 'file' };
}
