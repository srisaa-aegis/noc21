-- Platform objects that the schema DSL cannot express:
--   * foreign keys that would create an import cycle in the schema modules
--   * check constraints
--   * append-only and immutability guards
--   * the status guard (system statuses can never be removed or reinterpreted)
--   * cache versioning triggers (bump + NOTIFY) that back the caching strategy
--   * read views used by the lists, the dashboards and the reports

-- ── Deferred foreign keys ────────────────────────────────────────────────────
ALTER TABLE "files"
  ADD CONSTRAINT "files_uploaded_by_users_id_fk"
  FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "applications"
  ADD CONSTRAINT "applications_parent_fk"
  FOREIGN KEY ("parent_application_id") REFERENCES "applications"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "applications"
  ADD CONSTRAINT "applications_child_fk"
  FOREIGN KEY ("child_application_id") REFERENCES "applications"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "re_rule_sets"
  ADD CONSTRAINT "re_rule_sets_current_version_fk"
  FOREIGN KEY ("current_version_id") REFERENCES "re_rule_set_versions"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "wf_definitions"
  ADD CONSTRAINT "wf_definitions_current_version_fk"
  FOREIGN KEY ("current_version_id") REFERENCES "wf_definition_versions"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "wf_tasks"
  ADD CONSTRAINT "wf_tasks_supersedes_fk"
  FOREIGN KEY ("supersedes_task_id") REFERENCES "wf_tasks"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "notification_outbox"
  ADD CONSTRAINT "notification_outbox_application_fk"
  FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE set null;
--> statement-breakpoint

-- ── Check constraints ────────────────────────────────────────────────────────
ALTER TABLE "application_feedback" ADD CONSTRAINT "application_feedback_rating_ck" CHECK (rating BETWEEN 1 AND 5);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_ck" CHECK (amount >= 0);
--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_revision_ck" CHECK (revision >= 1);
--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_validity_ck" CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from);
--> statement-breakpoint
ALTER TABLE "wf_sla_policies" ADD CONSTRAINT "wf_sla_total_ck" CHECK (total_days BETWEEN 1 AND 365);
--> statement-breakpoint
ALTER TABLE "wf_escalation_settings" ADD CONSTRAINT "wf_escalation_settings_single_ck" CHECK (id = 1);
--> statement-breakpoint
ALTER TABLE "wf_escalation_settings" ADD CONSTRAINT "wf_escalation_settings_interval_ck" CHECK (remind_every_days >= 1);
--> statement-breakpoint

-- ── Append-only / immutability guards ────────────────────────────────────────
-- Append-only, except for an explicit purge (the seed / reset scripts set
-- `SET LOCAL noc.allow_purge = 'on'` inside their transaction).
CREATE OR REPLACE FUNCTION noc_forbid_change() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('noc.allow_purge', true), 'off') = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION '% rows are append-only and cannot be %', TG_TABLE_NAME, lower(TG_OP);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION noc_forbid_change();
--> statement-breakpoint
CREATE TRIGGER application_revisions_append_only BEFORE UPDATE OR DELETE ON "application_revisions"
  FOR EACH ROW EXECUTE FUNCTION noc_forbid_change();
--> statement-breakpoint
CREATE TRIGGER wf_events_append_only BEFORE UPDATE OR DELETE ON "wf_events"
  FOR EACH ROW EXECUTE FUNCTION noc_forbid_change();
--> statement-breakpoint

-- A published rule-set version is immutable; only its status may be retired.
CREATE OR REPLACE FUNCTION noc_rule_version_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'published' AND (
       NEW.definition IS DISTINCT FROM OLD.definition OR
       NEW.version    IS DISTINCT FROM OLD.version OR
       NEW.rule_set_id IS DISTINCT FROM OLD.rule_set_id
     ) THEN
    RAISE EXCEPTION 'Published rule-set version %/% is immutable.', OLD.rule_set_id, OLD.version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER re_rule_set_versions_immutable BEFORE UPDATE ON "re_rule_set_versions"
  FOR EACH ROW EXECUTE FUNCTION noc_rule_version_immutable();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION noc_wf_version_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.definition IS DISTINCT FROM OLD.definition OR NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION 'Workflow definition version %/% is immutable.', OLD.definition_id, OLD.version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER wf_definition_versions_immutable BEFORE UPDATE ON "wf_definition_versions"
  FOR EACH ROW EXECUTE FUNCTION noc_wf_version_immutable();
--> statement-breakpoint

-- ── Status guard (decision N-4) ──────────────────────────────────────────────
-- System statuses (Draft, Submitted, Approved, Returned, Rejected) can never be
-- deleted or re-categorised. A status that has been used by an application can
-- be deactivated (dropped from the workflows) but not removed.
CREATE OR REPLACE FUNCTION noc_status_guard() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('noc.allow_purge', true), 'off') = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system THEN
      RAISE EXCEPTION 'Status "%" is a system status and cannot be deleted.', OLD.name;
    END IF;
    IF EXISTS (SELECT 1 FROM applications WHERE status_id = OLD.id)
       OR EXISTS (SELECT 1 FROM process_log WHERE status_id = OLD.id) THEN
      RAISE EXCEPTION 'Status "%" has been used and cannot be deleted; deactivate it instead.', OLD.name;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.is_system AND (NEW.category IS DISTINCT FROM OLD.category OR NEW.is_system IS DISTINCT FROM OLD.is_system) THEN
    RAISE EXCEPTION 'System status "%" cannot be reinterpreted.', OLD.name;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER statuses_guard BEFORE UPDATE OR DELETE ON "statuses"
  FOR EACH ROW EXECUTE FUNCTION noc_status_guard();
--> statement-breakpoint
CREATE UNIQUE INDEX "statuses_pre_decision_uq" ON "statuses" ((true)) WHERE is_pre_decision AND active;
--> statement-breakpoint

-- ── Cache versioning: bump + NOTIFY on every change of cached source data ────
CREATE OR REPLACE FUNCTION noc_bump_cache() RETURNS trigger AS $$
DECLARE
  target text := TG_ARGV[0];
  v integer;
BEGIN
  -- Bulk loaders (seed, reset) suppress per-statement bumps and bump once at the end.
  IF coalesce(current_setting('noc.suppress_cache_bump', true), 'off') = 'on' THEN
    RETURN NULL;
  END IF;
  INSERT INTO cache_versions (bundle, version, updated_at)
       VALUES (target, 1, now())
  ON CONFLICT (bundle) DO UPDATE SET version = cache_versions.version + 1, updated_at = now()
    RETURNING version INTO v;
  PERFORM pg_notify('noc_cache', target || ':' || v);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DO $$
DECLARE
  t text;
  reference_tables text[] := ARRAY[
    'regions','districts','fire_stations','application_types','application_type_modes','build_types',
    'build_sub_types','directions','hazards','mapped_codes','equipments','ffe_notes','statuses',
    'dept_roles','party_roles','block_option_values','document_requirements','occupancy_conditions',
    'undertakings'];
  content_tables text[] := ARRAY['reference_documents'];
  rules_tables text[] := ARRAY['re_rule_sets','re_rule_set_versions'];
  workflow_tables text[] := ARRAY['wf_forms','wf_definitions','wf_definition_versions','wf_sla_policies',
    'wf_escalation_settings','noc_workflow_bindings'];
  directory_tables text[] := ARRAY['dept_profiles','dept_user_stations'];
BEGIN
  FOREACH t IN ARRAY reference_tables LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION noc_bump_cache(''reference'')', t || '_cache_bump', t);
  END LOOP;
  FOREACH t IN ARRAY content_tables LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION noc_bump_cache(''content'')', t || '_cache_bump', t);
  END LOOP;
  FOREACH t IN ARRAY rules_tables LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION noc_bump_cache(''rules'')', t || '_cache_bump', t);
  END LOOP;
  FOREACH t IN ARRAY workflow_tables LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION noc_bump_cache(''workflow'')', t || '_cache_bump', t);
  END LOOP;
  FOREACH t IN ARRAY directory_tables LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION noc_bump_cache(''directory'')', t || '_cache_bump', t);
  END LOOP;
END $$;
--> statement-breakpoint

INSERT INTO cache_versions (bundle, version) VALUES
  ('reference', 1), ('rules', 1), ('content', 1), ('workflow', 1), ('directory', 1)
ON CONFLICT (bundle) DO NOTHING;
--> statement-breakpoint

-- ── Full-text search over applications ───────────────────────────────────────
ALTER TABLE "applications"
  ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple',
      coalesce(appl_number, '') || ' ' || coalesce(site_name, '') || ' ' ||
      coalesce(site_addr, '')   || ' ' || coalesce(build_name, ''))
  ) STORED;
--> statement-breakpoint
CREATE INDEX "applications_search_idx" ON "applications" USING gin ("search_vector");
--> statement-breakpoint

-- ── Views ────────────────────────────────────────────────────────────────────
-- The latest row of every workflow task (send back and re-inspection append rows).
CREATE VIEW "v_current_tasks" AS
SELECT DISTINCT ON (t.instance_id, t.stage_key, t.task_key) t.*
FROM wf_tasks t
ORDER BY t.instance_id, t.stage_key, t.task_key, t.task_no DESC;
--> statement-breakpoint

CREATE VIEW "v_active_tasks" AS
SELECT ct.*, i.subject_id AS application_id, i.definition_id, i.decider_user_id
FROM v_current_tasks ct
JOIN wf_instances i ON i.id = ct.instance_id AND i.status = 'running'
WHERE ct.state = 'active';
--> statement-breakpoint

-- The flat list row used by every dashboard, queue and search screen.
CREATE VIEW "v_application_summary" AS
SELECT
  a.id                                    AS appl_id,
  a.appl_number,
  at.code                                 AS appl_type,
  coalesce(m.code, '')                    AS appl_mode,
  a.revision,
  u.username                              AS owner,
  a.site_name,
  a.site_addr,
  coalesce(b0.site_type, '')              AS site_type,
  a.max_height                            AS height,
  a.floor_count                           AS flr_count,
  a.built_area_total                      AS built_area,
  a.build_name,
  a.build_landline,
  a.build_mobile,
  a.build_email,
  coalesce(p.amount, 0)                   AS challan_amt,
  a.applied_date,
  a.final_date,
  a.last_modified,
  a.status_id,
  s.category                              AS status_category,
  a.delegation_level,
  coalesce(d.name, '')                    AS dist_name,
  a.district_id,
  a.fire_station_id,
  a.host_name,
  a.reviewer,
  coalesce(a.parent_application_id, 0)    AS parent_id,
  coalesce(a.child_application_id, 0)     AS child_id,
  (SELECT count(*) FROM document_requests dr WHERE dr.application_id = a.id AND dr.status = 'R') AS pending_requests,
  a.valid_to,
  f.rating,
  (p.status = 'paid')                     AS challan_paid,
  EXISTS (SELECT 1 FROM application_documents ad WHERE ad.application_id = a.id AND ad.deleted_at IS NULL AND ad.code = 'BankGuarantee') AS bank_guarantee,
  EXISTS (SELECT 1 FROM application_documents ad WHERE ad.application_id = a.id AND ad.deleted_at IS NULL AND ad.code = 'Undertaking')   AS undertaking,
  EXISTS (SELECT 1 FROM application_documents ad WHERE ad.application_id = a.id AND ad.deleted_at IS NULL AND ad.code = 'Form16')        AS form16,
  EXISTS (SELECT 1 FROM application_documents ad WHERE ad.application_id = a.id AND ad.deleted_at IS NULL AND ad.code LIKE 'SitePlan%')  AS fire_draw_5,
  a.deleted_at
FROM applications a
JOIN application_types at ON at.id = a.application_type_id
LEFT JOIN application_type_modes m ON m.id = a.application_type_mode_id
JOIN users u ON u.id = a.owner_user_id
JOIN statuses s ON s.id = a.status_id
LEFT JOIN districts d ON d.id = a.district_id
LEFT JOIN payments p ON p.application_id = a.id
LEFT JOIN application_feedback f ON f.application_id = a.id
LEFT JOIN LATERAL (
  SELECT b.site_type FROM blocks b WHERE b.application_id = a.id ORDER BY b.block_no LIMIT 1
) b0 ON true;
--> statement-breakpoint

-- Common FROM clause of the department reports.
CREATE VIEW "v_report_base" AS
SELECT
  a.id AS application_id, at.code AS appl_type, a.delegation_level, a.status_id, s.category AS status_category,
  a.district_id, d.region_id, a.applied_date, a.final_date, a.host_name, a.built_area_total, a.max_height,
  coalesce(p.amount, 0) AS fee_amount, a.appl_number, a.site_name, a.build_name, a.reviewer, a.stage_label
FROM applications a
JOIN application_types at ON at.id = a.application_type_id
JOIN statuses s ON s.id = a.status_id
LEFT JOIN districts d ON d.id = a.district_id
LEFT JOIN payments p ON p.application_id = a.id
WHERE a.deleted_at IS NULL AND s.category <> 'draft';
