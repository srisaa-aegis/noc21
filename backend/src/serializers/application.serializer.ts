/**
 * Database rows → the wire shapes of @srisaa/noc-domain (the shapes the portal
 * already consumes). Local ids (`block_id`, `floor_id`, `doc_id`, `task_id`, …)
 * come from the `*_no` columns; dates are rendered in the configured API format.
 */
import type {
  Application,
  ApplicationSummary,
  Block,
  BlockFfe,
  ProcessStep,
  WorkflowRun,
  WorkflowStageDef,
  WorkflowTask,
} from '@srisaa/noc-domain';
import { fromDateColumn, timestampToApiDate } from '../lib/dates.js';
import type { AggregateRows, SummaryRow } from '../repositories/application.repo.js';

const n = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));
const maybe = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v));

export interface SerializeOptions {
  /** Citizens never see the officers' note content. */
  hideInternalNotes?: boolean;
}

function toBlock(b: AggregateRows['blocks'][number]): Block {
  const ffe: BlockFfe = {
    items: b.ffe.map((item) => ({
      equip_id: item.equipmentId,
      level: item.level,
      floors: (item.cells?.floors ?? {}) as Block['ffe']['items'][number]['floors'],
      block: item.cells?.block ?? { reqt: null, prop: null, prov: null },
      note_keys: item.noteKeys ?? [],
      ...(item.added ? { added: true } : {}),
      remarks: item.remarks,
    })),
    notes: b.block.ffeNoteKeys ?? [],
    agree_reqt: b.block.ffeAgreeReqt,
  };
  return {
    block_id: b.block.blockNo,
    sl_no: b.block.slNo,
    block_name: b.block.blockName,
    block_type: b.block.blockType,
    site_type: b.block.siteType,
    site_stype: b.block.siteSType,
    is_mixed: b.block.isMixed,
    is_multiplex: b.block.isMultiplex,
    is_miniplex: b.block.isMiniplex,
    beds: b.block.beds,
    height: n(b.block.height),
    permissible_height: n(b.block.permissibleHeight),
    road_wide: b.block.roadWide,
    roadwidening: b.roadWidening.map((r) => ({ rw_direc: r.direc, rw_reqd: n(r.rwReqd) })),
    xfer_sbak: b.block.xferSbak,
    front_dir: b.block.frontDir,
    sides: b.sides.map((x) => ({ bside_id: x.sideNo, direc: x.direc, ptype: x.ptype, pname: x.pname, width: n(x.width) })),
    floors: b.floors.map((f) => ({
      floor_id: f.floorNo,
      flr_type: f.flrType,
      flr_name: f.flrName,
      built_area: n(f.builtArea),
      occ_type: f.occType,
      occ_c_app: n(f.occCApp),
      seats_num: n(f.seatsNum),
      ...(f.parentBuiltArea !== null ? { parent_built_area: n(f.parentBuiltArea) } : {}),
      ...(f.parentOccCApp !== null ? { parent_occ_c_app: n(f.parentOccCApp) } : {}),
    })),
    ospaces: b.ospaces.map((o) => ({
      ospace_id: o.ospaceNo,
      direc: o.direc,
      proposed: n(o.proposed),
      ...(o.projection !== null ? { projection: n(o.projection) } : {}),
      ...(o.parentProposed !== null ? { parent_proposed: n(o.parentProposed) } : {}),
      ...(o.osPreqd !== null ? { os_preqd: n(o.osPreqd) } : {}),
    })),
    escapes: b.escapes.map((e) => ({
      escape_id: e.escapeNo,
      etype: e.etype,
      desc: e.description,
      width: n(e.width),
      location: e.location,
      ...(e.fromFloorNo !== null ? { from_floor: e.fromFloorNo } : {}),
      ...(e.toFloorNo !== null ? { to_floor: e.toFloorNo } : {}),
    })),
    exits: b.exits.map((x) => ({ exit_id: x.exitNo, ename: x.ename, width: n(x.width), awidth: n(x.awidth), direc: x.direc })),
    doors: b.doors.map((d) => ({ door_id: d.doorNo, desc: d.description, width: n(d.width), location: d.location })),
    lifts: b.lifts.map((l) => ({ lift_id: l.liftNo, ltype: l.ltype, lname: l.lname, capacity: n(l.capacity) })),
    refuges: b.refuges.map((r) => ({ refuge_id: r.refugeNo, floor_id: n(r.floorNo), area: n(r.area) })),
    carparks: b.carparks.map((c) => ({ cpark_id: c.cparkNo, floor: c.floor, capacity: n(c.capacity) })),
    ta_dist: n(b.block.taDist),
    ta_dead: n(b.block.taDead),
    hrclear: n(b.block.hrclear),
    ffe,
  };
}

function toRun(i: AggregateRows['instances'][number], options: SerializeOptions): WorkflowRun {
  const body = i.definition as { stages: WorkflowStageDef[] };
  const tasks: WorkflowTask[] = i.tasks.map((t) => ({
    task_id: t.taskNo,
    stage_key: t.stageKey,
    task_key: t.taskKey,
    name: t.name,
    role_id: t.roleId ?? 0,
    assignee: t.assigneeUsername,
    assignee_name: t.assigneeName,
    state: t.state,
    ...(t.activatedAt ? { start_date: timestampToApiDate(t.activatedAt) } : {}),
    ...(t.completedAt ? { end_date: timestampToApiDate(t.completedAt) } : {}),
    form: t.formCode ?? '',
    data: options.hideInternalNotes ? {} : ((t.data ?? {}) as Record<string, unknown>),
    draft: t.draft,
    remarks: options.hideInternalNotes ? '' : t.remarks,
    ...(t.resultCode ? { recommendation: t.resultCode as 'Y' | 'N' } : {}),
    ...(t.outcome ? { decision: t.outcome as WorkflowTask['decision'] } : {}),
    ...(t.sentBackToStage ? { sent_back_to: t.sentBackToStage } : {}),
  }));
  return {
    definition_code: i.definitionCode,
    version: i.definitionVersion,
    revision: i.instance.cycle,
    started_on: timestampToApiDate(i.instance.startedAt),
    stages: body.stages,
    tasks,
    approver: i.deciderUsername,
    ...(i.instance.completedAt ? { completed_on: timestampToApiDate(i.instance.completedAt) } : {}),
    ...(i.instance.outcome ? { outcome: i.instance.outcome as WorkflowRun['outcome'] } : {}),
  };
}

export function toApplication(rows: AggregateRows, options: SerializeOptions = {}): Application {
  const a = rows.application;
  const current = rows.instances.find((i) => i.instance.status !== 'archived');
  const history = rows.instances.filter((i) => i.instance.status === 'archived');

  const processLog: ProcessStep[] = rows.processLog.map((p) => ({
    step_id: p.stepNo,
    uid: p.actorUserId ?? 0,
    reviewer_name: p.reviewerName,
    role: p.role,
    status_id: (p.statusId ?? 1) as ProcessStep['status_id'],
    action: p.action,
    remarks: p.remarks,
    at_date: fromDateColumn(p.atDate),
  }));

  return {
    appl_id: a.id,
    appl_number: a.applNumber ?? '',
    appl_type: rows.typeCode as Application['appl_type'],
    appl_mode: rows.modeCode,
    revision: a.revision,
    owner: rows.ownerUsername,

    site_name: a.siteName,
    site_addr: a.siteAddr,
    district: a.districtId ?? 0,
    dist_name: rows.districtName,
    fire_station_id: a.fireStationId ?? 0,
    corr_addr: a.corrAddr,

    plot_area: n(a.plotArea),
    perimeter: n(a.perimeter),
    lic_auth: a.licAuth,
    lic_addr: a.licAddr,

    build_name: a.buildName,
    build_landline: a.buildLandline,
    build_mobile: a.buildMobile,
    build_email: a.buildEmail,
    build_aadhar: a.buildAadhar,

    ref_no: a.refNo,
    last_inspect_date: fromDateColumn(a.lastInspectDate),

    applied_date: fromDateColumn(a.appliedDate),
    final_date: fromDateColumn(a.finalDate),
    last_modified: timestampToApiDate(a.lastModified),
    status_id: a.statusId as Application['status_id'],
    delegation_level: a.delegationLevel,
    reviewer: a.reviewer,

    loc_lat: n(a.locLat),
    loc_lng: n(a.locLng),
    host_name: a.hostName ?? null,

    parent_id: a.parentApplicationId ?? 0,
    child_id: a.childApplicationId ?? 0,

    declaration_accepted: a.declarationAccepted,
    mcapprove_date: fromDateColumn(a.mcapproveDate),
    conditions: rows.conditions.map((c) => ({ checklist_id: c.checklistNo, item_desc: c.itemDesc, selected: c.selected })),
    ...(a.validFrom ? { valid_from: fromDateColumn(a.validFrom) } : {}),
    ...(a.validTo ? { valid_to: fromDateColumn(a.validTo) } : {}),
    ...(rows.feedback
      ? { feedback: { rating: rows.feedback.rating, remarks: rows.feedback.remarks, rated_on: fromDateColumn(rows.feedback.ratedOn) } }
      : {}),
    ...(a.nocLevel ? { noc_level: a.nocLevel } : {}),
    ...(current ? { workflow: toRun(current, options) } : {}),
    ...(history.length ? { workflow_history: history.map((h) => toRun(h, options)) } : {}),
    stage_label: a.stageLabel,
    dept_documents: rows.deptDocuments.map((d) => ({
      doc_id: d.docNo,
      file_name: d.originalName ?? d.fileNameFallback,
      description: d.description,
      uploaded_by: d.uploadedByName,
      uploaded_on: fromDateColumn(d.uploadedOn),
      ...(d.fileId ? { file_id: d.fileId } : {}),
    })) as Application['dept_documents'],
    sms: rows.sms.map((m) => ({
      sms_id: m.smsNo,
      message: m.message,
      sent_by: m.sentByName,
      sent_on: fromDateColumn(m.sentOn),
    })),

    parties: rows.parties.map((p) => ({
      sl_no: p.slNo,
      role_name: p.roleName,
      party_name: p.partyName,
      phone_number: p.phoneNumber,
      email: p.email,
      license_no: p.licenseNo,
    })),
    blocks: rows.blocks.map(toBlock),
    deptfiles: rows.documentRequests.map((r) => ({
      fileid: r.requestNo,
      appid: a.id,
      processid: r.taskNo ?? 0,
      file_name: r.fileName,
      file_desc: r.fileDesc,
      status: r.status,
      citizen_comment: r.citizenComment,
      requested_by: r.requestedByName,
      requested_on: fromDateColumn(r.requestedOn),
    })),
    documents: rows.documents.map((d) => {
      const size = d.sizeBytes ?? d.sizeFallback;
      return {
        doc_id: d.docNo,
        code: d.code,
        file_name: d.originalName ?? d.fileNameFallback,
        category: d.category,
        uploaded_on: fromDateColumn(d.uploadedOn),
        ...(size !== null && size !== undefined ? { size: Number(size) } : {}),
        ...(d.fileId ? { file_id: d.fileId } : {}),
      };
    }) as Application['documents'],
    processLog,
    payment: {
      mode: rows.payment?.mode ?? null,
      amount: n(rows.payment?.amount),
      status: rows.payment?.status ?? 'pending',
      challan_num: rows.payment?.challanNum ?? '',
      challan_date: fromDateColumn(rows.payment?.challanDate),
      challan_bnk: rows.payment?.challanBank ?? '',
      challan_brch: rows.payment?.challanBranch ?? '',
      txn_ref: rows.payment?.txnRef ?? '',
      paid_on: fromDateColumn(rows.payment?.paidOn),
    },
    row_version: a.rowVersion,
  } as Application & { row_version: number };
}

export function toSummaryDto(row: SummaryRow): ApplicationSummary & { days_idle: number | null; fire_station_id: number | null; status_category: string } {
  return {
    appl_id: row.appl_id,
    appl_number: row.appl_number ?? '',
    appl_type: row.appl_type as ApplicationSummary['appl_type'],
    appl_mode: row.appl_mode,
    revision: row.revision,
    owner: row.owner,
    site_name: row.site_name,
    site_addr: row.site_addr,
    site_type: row.site_type,
    height: n(row.height),
    flr_count: n(row.flr_count),
    built_area: n(row.built_area),
    build_name: row.build_name,
    build_landline: row.build_landline,
    build_mobile: row.build_mobile,
    build_email: row.build_email,
    challan_amt: n(row.challan_amt),
    applied_date: fromDateColumn(row.applied_date),
    final_date: fromDateColumn(row.final_date),
    last_modified: timestampToApiDate(row.last_modified),
    status_id: row.status_id as ApplicationSummary['status_id'],
    status_category: row.status_category,
    delegation_level: row.delegation_level as ApplicationSummary['delegation_level'],
    dist_name: row.dist_name,
    fire_station_id: row.fire_station_id,
    host_name: (row.host_name ?? null) as ApplicationSummary['host_name'],
    reviewer: row.reviewer,
    parent_id: row.parent_id,
    child_id: row.child_id,
    pending_requests: n(row.pending_requests),
    valid_to: row.valid_to ? fromDateColumn(row.valid_to) : undefined,
    rating: maybe(row.rating),
    challan_paid: !!row.challan_paid,
    bank_guarantee: row.bank_guarantee,
    undertaking: row.undertaking,
    form16: row.form16,
    fire_draw_5: row.fire_draw_5,
    days_idle: row.days_idle === null ? null : Number(row.days_idle),
  };
}
