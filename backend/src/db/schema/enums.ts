import { pgEnum } from 'drizzle-orm/pg-core';

export const portalKind = pgEnum('portal_kind', ['citizen', 'dept', 'admin']);
export const delegationLevel = pgEnum('delegation_level', ['MSB', 'RFO', 'DFO']);
export const hostKind = pgEnum('host_kind', ['SDP', 'MAUD']);
export const statusCategory = pgEnum('status_category', [
  'draft',
  'submitted',
  'in_process',
  'approved',
  'returned',
  'rejected',
]);
export const paymentMode = pgEnum('payment_mode', ['online', 'challan']);
export const paymentStatus = pgEnum('payment_status', ['pending', 'paid', 'failed']);
export const docRequestStatus = pgEnum('doc_request_status', ['R', 'U', 'C']);
export const revisionKind = pgEnum('revision_kind', ['submitted', 'decided', 'archived']);
export const storageBackend = pgEnum('storage_backend', ['fs', 's3']);
export const notificationKind = pgEnum('notification_kind', ['sms', 'email']);
export const equipmentLevel = pgEnum('equipment_level', ['F', 'B']);

export const reRuleKind = pgEnum('re_rule_kind', ['decision_tree', 'decision_table', 'parameters']);
export const reVersionStatus = pgEnum('re_version_status', ['draft', 'published', 'retired']);

export const wfFormKind = pgEnum('wf_form_kind', ['structured', 'questionnaire']);
export const wfInstanceStatus = pgEnum('wf_instance_status', ['running', 'completed', 'archived']);
export const wfTaskState = pgEnum('wf_task_state', [
  'waiting',
  'active',
  'done',
  'skipped',
  'sent_back',
  'not_required',
]);
export const wfEscalationKind = pgEnum('wf_escalation_kind', ['step', 'sla_class', 'total']);
