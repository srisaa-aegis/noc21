/**
 * Writing the application aggregate.
 *
 * Shared by the seeder and by the save / create / carry-forward endpoints, so
 * the data the demo starts with and the data the portal writes go through the
 * same code. Only the fields a citizen owns are written from a payload; the
 * server owns numbering, status, dates, payments, documents and the workflow.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import type { Application, Block } from '@srisaa/noc-domain';
import type { Database } from '../db/client.js';
import * as s from '../db/schema/index.js';
import { toDateColumn } from '../lib/dates.js';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0] | Database;

export const num = (v: unknown, fallback = 0): string => String(Number(v) || fallback);
export const int = (v: unknown, fallback = 0): number => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : fallback);

/** Dropped legacy station ids (seed correction N-1) and non-numeric ids map to null. */
export function stationIdOf(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export interface ReferenceIds {
  typeByCode: Map<string, number>;
  modeByTypeAndCode: Map<string, number>;
  buildTypeByCode: Map<string, number>;
  subTypeByKey: Map<string, number>;
  directionByCode: Map<string, number>;
  partyRoleByName: Map<string, number>;
  userByUsername: Map<string, number>;
  formByCode: Map<string, number>;
  definitionByCode: Map<string, { id: number; versionId: number }>;
  equipmentIds: Set<number>;
}

export async function loadReferenceIds(tx: Tx): Promise<ReferenceIds> {
  const types = await tx.select({ id: s.applicationTypes.id, code: s.applicationTypes.code }).from(s.applicationTypes);
  const modes = await tx
    .select({ id: s.applicationTypeModes.id, code: s.applicationTypeModes.code, typeId: s.applicationTypeModes.applicationTypeId })
    .from(s.applicationTypeModes);
  const buildTypes = await tx.select({ id: s.buildTypes.id, code: s.buildTypes.code }).from(s.buildTypes);
  const subTypes = await tx
    .select({ id: s.buildSubTypes.id, code: s.buildSubTypes.code, parent: s.buildSubTypes.buildTypeId })
    .from(s.buildSubTypes);
  const directions = await tx.select({ id: s.directions.id, code: s.directions.code }).from(s.directions);
  const partyRoles = await tx.select({ id: s.partyRoles.id, name: s.partyRoles.name }).from(s.partyRoles);
  const users = await tx.select({ id: s.users.id, username: s.users.username }).from(s.users);
  const forms = await tx.select({ id: s.wfForms.id, code: s.wfForms.code }).from(s.wfForms);
  const defs = await tx
    .select({ id: s.wfDefinitions.id, code: s.wfDefinitions.code, versionId: s.wfDefinitions.currentVersionId })
    .from(s.wfDefinitions);
  const equipments = await tx.select({ id: s.equipments.id }).from(s.equipments);

  const typeByCode = new Map(types.map((t) => [t.code, t.id]));
  return {
    typeByCode,
    modeByTypeAndCode: new Map(modes.map((m) => [`${m.typeId}:${m.code}`, m.id])),
    buildTypeByCode: new Map(buildTypes.map((b) => [b.code, b.id])),
    subTypeByKey: new Map(subTypes.map((x) => [`${x.parent}:${x.code.toUpperCase()}`, x.id])),
    directionByCode: new Map(directions.map((d) => [d.code, d.id])),
    partyRoleByName: new Map(partyRoles.map((p) => [p.name, p.id])),
    userByUsername: new Map(users.map((u) => [u.username, u.id])),
    formByCode: new Map(forms.map((f) => [f.code, f.id])),
    definitionByCode: new Map(defs.filter((d) => d.versionId).map((d) => [d.code, { id: d.id, versionId: d.versionId as number }])),
    equipmentIds: new Set(equipments.map((e) => e.id)),
  };
}

/**
 * Inserts every block of an application and all their children with one
 * multi-row insert per table (the aggregate is written as a whole on save, so
 * statement count — not row count — is what costs).
 */
export async function insertBlocks(tx: Tx, applicationId: number, app: Pick<Application, 'blocks'>, ids: ReferenceIds): Promise<number> {
  const blocks = app.blocks ?? [];
  if (!blocks.length) return 0;
  const rows = await tx
    .insert(s.blocks)
    .values(
      blocks.map((block, i) => {
        const buildTypeId = ids.buildTypeByCode.get(block.site_type) ?? null;
        return {
          applicationId,
          blockNo: block.block_id,
          slNo: block.sl_no ?? i + 1,
          blockName: block.block_name ?? '',
          blockType: block.block_type || 'N',
          buildTypeId,
          siteType: block.site_type ?? '',
          buildSubTypeId: buildTypeId ? (ids.subTypeByKey.get(`${buildTypeId}:${(block.site_stype ?? '').toUpperCase()}`) ?? null) : null,
          siteSType: block.site_stype ?? '',
          isMixed: !!block.is_mixed,
          isMultiplex: !!block.is_multiplex,
          isMiniplex: !!block.is_miniplex,
          beds: block.beds ?? '',
          height: num(block.height),
          permissibleHeight: num(block.permissible_height),
          roadWide: !!block.road_wide,
          xferSbak: !!block.xfer_sbak,
          frontDirectionId: ids.directionByCode.get(block.front_dir) ?? null,
          frontDir: block.front_dir ?? '',
          taDist: num(block.ta_dist),
          taDead: num(block.ta_dead),
          hrclear: num(block.hrclear),
          ffeNoteKeys: block.ffe?.notes ?? [],
          ffeAgreeReqt: !!block.ffe?.agree_reqt,
          builtAreaTotal: num((block.floors ?? []).reduce((sum, f) => sum + (Number(f.built_area) || 0), 0)),
        };
      }),
    )
    .returning({ id: s.blocks.id, blockNo: s.blocks.blockNo });
  const idOf = new Map(rows.map((r) => [r.blockNo, r.id]));
  const each = <T>(fn: (blockId: number, block: Block) => T[]): T[] =>
    blocks.flatMap((b) => fn(idOf.get(b.block_id) as number, b));

  const roadWidening = each((blockId, b) => {
    const seen = new Set<string>();
    return (b.roadwidening ?? [])
      .filter((rw) => (seen.has(rw.rw_direc) ? false : (seen.add(rw.rw_direc), true)))
      .map((rw) => ({ blockId, direc: rw.rw_direc, rwReqd: num(rw.rw_reqd) }));
  });
  const sides = each((blockId, b) =>
    (b.sides ?? []).map((side) => ({
      blockId,
      sideNo: side.bside_id,
      direc: side.direc ?? '',
      ptype: side.ptype ?? '',
      pname: side.pname ?? '',
      width: num(side.width),
    })),
  );
  const floors = each((blockId, b) =>
    (b.floors ?? []).map((f, i) => ({
      blockId,
      floorNo: f.floor_id,
      ordinal: i,
      flrType: f.flr_type ?? 'F',
      flrName: f.flr_name ?? '',
      builtArea: num(f.built_area),
      occType: f.occ_type ?? '',
      occCApp: int(f.occ_c_app),
      seatsNum: int(f.seats_num),
      parentBuiltArea: f.parent_built_area === undefined || f.parent_built_area === null ? null : num(f.parent_built_area),
      parentOccCApp: f.parent_occ_c_app === undefined || f.parent_occ_c_app === null ? null : int(f.parent_occ_c_app),
    })),
  );
  const ospaces = each((blockId, b) =>
    (b.ospaces ?? []).map((o) => ({
      blockId,
      ospaceNo: o.ospace_id,
      direc: o.direc ?? '',
      proposed: num(o.proposed),
      projection: o.projection === undefined || o.projection === null ? null : num(o.projection),
      parentProposed: o.parent_proposed === undefined || o.parent_proposed === null ? null : num(o.parent_proposed),
      osPreqd: o.os_preqd === undefined || o.os_preqd === null ? null : num(o.os_preqd),
    })),
  );
  const escapes = each((blockId, b) =>
    (b.escapes ?? []).map((e) => ({
      blockId,
      escapeNo: e.escape_id,
      etype: e.etype ?? '',
      description: e.desc ?? '',
      width: num(e.width),
      location: e.location ?? '',
      fromFloorNo: e.from_floor ?? null,
      toFloorNo: e.to_floor ?? null,
    })),
  );
  const exits = each((blockId, b) =>
    (b.exits ?? []).map((x) => ({ blockId, exitNo: x.exit_id, ename: x.ename ?? '', width: num(x.width), awidth: num(x.awidth), direc: x.direc ?? '' })),
  );
  const doors = each((blockId, b) =>
    (b.doors ?? []).map((d) => ({ blockId, doorNo: d.door_id, description: d.desc ?? '', width: num(d.width), location: d.location ?? '' })),
  );
  const lifts = each((blockId, b) =>
    (b.lifts ?? []).map((l) => ({ blockId, liftNo: l.lift_id, ltype: l.ltype ?? '', lname: l.lname ?? '', capacity: int(l.capacity) })),
  );
  const refuges = each((blockId, b) =>
    (b.refuges ?? []).map((r) => ({ blockId, refugeNo: r.refuge_id, floorNo: r.floor_id ?? null, area: num(r.area) })),
  );
  const carparks = each((blockId, b) =>
    (b.carparks ?? []).map((c) => ({ blockId, cparkNo: c.cpark_id, floor: String(c.floor ?? ''), capacity: int(c.capacity) })),
  );
  const ffe = each((blockId, b) =>
    (b.ffe?.items ?? [])
      .filter((item) => ids.equipmentIds.has(item.equip_id))
      .map((item, i) => {
        const reqt = Number(item.block?.reqt);
        const prov = Number(item.block?.prov);
        const reqtOk = item.block?.reqt !== null && item.block?.reqt !== undefined && item.block?.reqt !== '' && Number.isFinite(reqt);
        const provOk = item.block?.prov !== null && item.block?.prov !== undefined && Number.isFinite(prov);
        return {
          blockId,
          equipmentId: item.equip_id,
          level: item.level,
          noteKeys: item.note_keys ?? [],
          added: !!item.added,
          remarks: item.remarks ?? '',
          ordinal: i,
          cells: { floors: item.floors ?? {}, block: item.block ?? { reqt: null, prop: null, prov: null } },
          reqtTotal: reqtOk ? String(reqt) : null,
          provTotal: provOk ? String(prov) : null,
          hasShortfall: reqtOk && provOk ? prov < reqt : false,
        };
      }),
  );

  if (roadWidening.length) await tx.insert(s.blockRoadWidening).values(roadWidening);
  if (sides.length) await tx.insert(s.blockSides).values(sides);
  if (floors.length) await tx.insert(s.blockFloors).values(floors);
  if (ospaces.length) await tx.insert(s.blockOspaces).values(ospaces);
  if (escapes.length) await tx.insert(s.blockEscapes).values(escapes);
  if (exits.length) await tx.insert(s.blockExits).values(exits);
  if (doors.length) await tx.insert(s.blockDoors).values(doors);
  if (lifts.length) await tx.insert(s.blockLifts).values(lifts);
  if (refuges.length) await tx.insert(s.blockRefuges).values(refuges);
  if (carparks.length) await tx.insert(s.blockCarparks).values(carparks);
  if (ffe.length) await tx.insert(s.blockFfeItems).values(ffe);
  return floors.length;
}

/** The client-owned scalar columns of an application, from a payload. */
/**
 * Aadhaar is never stored in full (decision: masked): only the last four digits
 * are kept, as `XXXXXXXX1234`. A value that is already masked stays as it is.
 */
export function maskAadhaar(value: string | null | undefined): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  return `XXXXXXXX${digits.slice(-4)}`;
}

export function ownedScalars(app: Application, ids: ReferenceIds, typeId: number) {
  return {
    applicationTypeModeId: ids.modeByTypeAndCode.get(`${typeId}:${app.appl_mode ?? ''}`) ?? null,
    siteName: (app.site_name ?? '').trim(),
    siteAddr: (app.site_addr ?? '').trim(),
    corrAddr: app.corr_addr ?? '',
    districtId: app.district ? Number(app.district) : null,
    fireStationId: stationIdOf(app.fire_station_id),
    plotArea: num(app.plot_area),
    perimeter: num(app.perimeter),
    licAuth: app.lic_auth ?? '',
    licAddr: app.lic_addr ?? '',
    buildName: app.build_name ?? '',
    buildLandline: app.build_landline ?? '',
    buildMobile: app.build_mobile ?? '',
    buildEmail: app.build_email ?? '',
    buildAadhar: maskAadhaar(app.build_aadhar),
    refNo: app.ref_no ?? '',
    nocLevel: app.noc_level ?? null,
    lastInspectDate: toDateColumn(app.last_inspect_date),
    mcapproveDate: toDateColumn(app.mcapprove_date),
    locLat: num(app.loc_lat),
    locLng: num(app.loc_lng),
    declarationAccepted: !!app.declaration_accepted,
  };
}

/** Parties, conditions and blocks of an application (replaces what was there). */
export async function writeOwnedChildren(tx: Tx, applicationId: number, app: Application, ids: ReferenceIds, replace: boolean): Promise<void> {
  if (replace) {
    await tx.delete(s.applicationParties).where(eq(s.applicationParties.applicationId, applicationId));
    await tx.delete(s.applicationConditions).where(eq(s.applicationConditions.applicationId, applicationId));
    await tx.delete(s.blocks).where(eq(s.blocks.applicationId, applicationId)); // cascades to every block child
  }
  const parties = (app.parties ?? []).map((p, i) => ({
    applicationId,
    slNo: p.sl_no || i + 1,
    partyRoleId: ids.partyRoleByName.get(p.role_name) ?? null,
    roleName: p.role_name,
    partyName: p.party_name ?? '',
    phoneNumber: p.phone_number ?? '',
    email: p.email ?? '',
    licenseNo: p.license_no ?? '',
  }));
  if (parties.length) await tx.insert(s.applicationParties).values(parties);
  const conditions = (app.conditions ?? []).map((c) => ({
    applicationId,
    checklistNo: c.checklist_id,
    itemDesc: c.item_desc,
    selected: c.selected,
  }));
  if (conditions.length) await tx.insert(s.applicationConditions).values(conditions);
  await insertBlocks(tx, applicationId, app, ids);
}

/** Recomputes the cached aggregates (area, height, counts) of some applications. */
export async function refreshCaches(tx: Tx, applicationIds?: number[]): Promise<void> {
  const filter = applicationIds?.length ? sql`and a.id in (${sql.join(applicationIds.map((i) => sql`${i}`), sql`, `)})` : sql``;
  await tx.execute(sql`
    update applications a set
      block_count = coalesce(b.blocks, 0),
      floor_count = coalesce(b.floors, 0),
      built_area_total = coalesce(b.area, 0),
      max_height = coalesce(b.height, 0)
    from (
      select x.id as application_id,
             count(distinct bl.id) as blocks,
             count(f.id) as floors,
             coalesce(sum(f.built_area), 0) as area,
             coalesce(max(bl.height), 0) as height
      from applications x
      left join blocks bl on bl.application_id = x.id
      left join block_floors f on f.block_id = bl.id
      group by x.id
    ) b where b.application_id = a.id ${filter}`);
  await tx.execute(sql`
    update blocks bl set built_area_total = coalesce((select sum(f.built_area) from block_floors f where f.block_id = bl.id), 0)
    ${applicationIds?.length ? sql`where bl.application_id in (${sql.join(applicationIds.map((i) => sql`${i}`), sql`, `)})` : sql``}`);
}

export { inArray };
