-- B3 performance review at 300 000 applications (docs/backend/B3-delivery-notes.md §4):
-- substring search over applications and accounts (pg_trgm), the joins of the queues,
-- the runs in process, per-status lists sorted by idle days.
-- pg_trgm is a trusted extension (PostgreSQL 13+): the database owner may create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
DROP INDEX "wf_tasks_assignee_idx";--> statement-breakpoint
DROP INDEX "applications_status_idx";--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "search_text" text GENERATED ALWAYS AS (lower(coalesce(appl_number, '') || ' ' || site_name || ' ' || site_addr || ' ' || build_name)) STORED;--> statement-breakpoint
CREATE INDEX "users_search_trgm_idx" ON "users" USING gin ((lower("username" || ' ' || "display_name" || ' ' || "email")) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "wf_instances_open_idx" ON "wf_instances" USING btree ("started_at") WHERE completed_at is null;--> statement-breakpoint
CREATE INDEX "applications_search_trgm_idx" ON "applications" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "applications_current_wf_idx" ON "applications" USING btree ("current_wf_instance_id");--> statement-breakpoint
CREATE INDEX "applications_station_idx" ON "applications" USING btree ("fire_station_id","status_id");--> statement-breakpoint
CREATE INDEX "wf_tasks_assignee_idx" ON "wf_tasks" USING btree ("assignee_user_id","state","instance_id");--> statement-breakpoint
CREATE INDEX "applications_status_idx" ON "applications" USING btree ("status_id","last_modified");