CREATE TABLE "agent_profile_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"agent" text NOT NULL,
	"version" integer NOT NULL,
	"settings" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_profile_versions_uq" UNIQUE NULLS NOT DISTINCT("agent","workspace_id","project_id","version")
);
--> statement-breakpoint
CREATE TABLE "automation_clients" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"allowed_actions" jsonb NOT NULL,
	"allowed_job_types" jsonb NOT NULL,
	"rate_limit_per_minute" integer NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"client_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"action" text,
	"idempotency_key" text,
	"request_hash" text,
	"status" text NOT NULL,
	"reason" text,
	"result" jsonb,
	"correlation_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_connectors" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"environment" text NOT NULL,
	"credential_ref" text NOT NULL,
	"schema_allowlist" jsonb NOT NULL,
	"statement_timeout_ms" integer NOT NULL,
	"status" text NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_error" text,
	"dictionary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "action_proposals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"risk_tier" text NOT NULL,
	"action" jsonb NOT NULL,
	"action_hash" text NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"result_job_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_threads" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"subject_job_id" uuid,
	"profile_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_turns" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"intent" jsonb,
	"basis" text NOT NULL,
	"sources" jsonb NOT NULL,
	"proposal_id" uuid,
	"idempotency_key" text,
	"request_hash" text,
	"reply_to" uuid,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_finding_explanations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"model" text NOT NULL,
	"profile_version_id" uuid,
	"claimed_at" timestamp with time zone NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "research_finding_sources" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"watchlist_id" uuid NOT NULL,
	"url" text NOT NULL,
	"publisher" text NOT NULL,
	"tier" text NOT NULL,
	"title" text NOT NULL,
	"published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_findings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"watchlist_id" uuid NOT NULL,
	"first_run_id" uuid NOT NULL,
	"title" text NOT NULL,
	"excerpt" text NOT NULL,
	"canonical_url" text NOT NULL,
	"label" text NOT NULL,
	"score_breakdown" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "research_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"watchlist_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"window_date" date,
	"idempotency_key" text,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"new_findings" integer DEFAULT 0 NOT NULL,
	"skipped_sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "research_watchlists" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"keywords" jsonb NOT NULL,
	"sources" jsonb NOT NULL,
	"weights" jsonb NOT NULL,
	"schedule" jsonb NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "health_checks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"incident_id" uuid,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL,
	"status_code" integer,
	"latency_ms" integer,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "incident_triages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"model" text NOT NULL,
	"profile_version_id" uuid,
	"claimed_at" timestamp with time zone NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"title" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"recovered_at" timestamp with time zone,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "monitored_apps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"environment" text NOT NULL,
	"health_url" text NOT NULL,
	"repository_id" text,
	"interval_seconds" integer NOT NULL,
	"timeout_ms" integer NOT NULL,
	"failure_threshold" integer NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "incident_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_profile_versions" ADD CONSTRAINT "agent_profile_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profile_versions" ADD CONSTRAINT "agent_profile_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_clients" ADD CONSTRAINT "automation_clients_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_client_id_automation_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."automation_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."conversation_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_turn_id_conversation_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."conversation_turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_result_job_id_jobs_id_fk" FOREIGN KEY ("result_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_threads" ADD CONSTRAINT "conversation_threads_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_threads" ADD CONSTRAINT "conversation_threads_subject_job_id_jobs_id_fk" FOREIGN KEY ("subject_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_threads" ADD CONSTRAINT "conversation_threads_profile_version_id_agent_profile_versions_id_fk" FOREIGN KEY ("profile_version_id") REFERENCES "public"."agent_profile_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."conversation_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_finding_explanations" ADD CONSTRAINT "research_finding_explanations_finding_id_research_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."research_findings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_finding_sources" ADD CONSTRAINT "research_finding_sources_finding_id_research_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."research_findings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_finding_sources" ADD CONSTRAINT "research_finding_sources_watchlist_id_research_watchlists_id_fk" FOREIGN KEY ("watchlist_id") REFERENCES "public"."research_watchlists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_findings" ADD CONSTRAINT "research_findings_watchlist_id_research_watchlists_id_fk" FOREIGN KEY ("watchlist_id") REFERENCES "public"."research_watchlists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_findings" ADD CONSTRAINT "research_findings_first_run_id_research_runs_id_fk" FOREIGN KEY ("first_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_watchlist_id_research_watchlists_id_fk" FOREIGN KEY ("watchlist_id") REFERENCES "public"."research_watchlists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_checks" ADD CONSTRAINT "health_checks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_checks" ADD CONSTRAINT "health_checks_app_id_monitored_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."monitored_apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_checks" ADD CONSTRAINT "health_checks_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_triages" ADD CONSTRAINT "incident_triages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_triages" ADD CONSTRAINT "incident_triages_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_app_id_monitored_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."monitored_apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_apps" ADD CONSTRAINT "monitored_apps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_clients_scope_idx" ON "automation_clients" USING btree ("workspace_id","project_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_accepted_key_uq" ON "automation_runs" USING btree ("client_id","idempotency_key") WHERE "automation_runs"."status" = 'ACCEPTED';--> statement-breakpoint
CREATE INDEX "automation_runs_client_idx" ON "automation_runs" USING btree ("client_id","id");--> statement-breakpoint
CREATE INDEX "automation_runs_scope_idx" ON "automation_runs" USING btree ("workspace_id","project_id","id");--> statement-breakpoint
CREATE INDEX "business_connectors_scope_idx" ON "business_connectors" USING btree ("workspace_id","project_id","id");--> statement-breakpoint
CREATE INDEX "action_proposals_thread_idx" ON "action_proposals" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "conversation_threads_scope_idx" ON "conversation_threads" USING btree ("workspace_id","project_id","owner_id","id");--> statement-breakpoint
CREATE INDEX "conversation_turns_thread_idx" ON "conversation_turns" USING btree ("thread_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_turns_idempotency_uq" ON "conversation_turns" USING btree ("thread_id","idempotency_key") WHERE "conversation_turns"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_turns_reply_uq" ON "conversation_turns" USING btree ("reply_to") WHERE "conversation_turns"."reply_to" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "research_finding_explanations_finding_uq" ON "research_finding_explanations" USING btree ("finding_id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_finding_sources_url_uq" ON "research_finding_sources" USING btree ("watchlist_id","url");--> statement-breakpoint
CREATE INDEX "research_finding_sources_finding_idx" ON "research_finding_sources" USING btree ("finding_id");--> statement-breakpoint
CREATE INDEX "research_findings_scope_idx" ON "research_findings" USING btree ("workspace_id","project_id","id");--> statement-breakpoint
CREATE INDEX "research_findings_watchlist_seen_idx" ON "research_findings" USING btree ("watchlist_id","first_seen_at");--> statement-breakpoint
CREATE INDEX "research_findings_run_idx" ON "research_findings" USING btree ("first_run_id");--> statement-breakpoint
CREATE INDEX "research_findings_fts_idx" ON "research_findings" USING gin (to_tsvector('english', "title" || ' ' || "excerpt"));--> statement-breakpoint
CREATE UNIQUE INDEX "research_runs_window_uq" ON "research_runs" USING btree ("watchlist_id","window_date");--> statement-breakpoint
CREATE UNIQUE INDEX "research_runs_idempotency_uq" ON "research_runs" USING btree ("watchlist_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "research_runs_watchlist_idx" ON "research_runs" USING btree ("workspace_id","project_id","watchlist_id","id");--> statement-breakpoint
CREATE INDEX "research_runs_running_idx" ON "research_runs" USING btree ("started_at") WHERE "research_runs"."status" = 'RUNNING';--> statement-breakpoint
CREATE INDEX "research_watchlists_scope_idx" ON "research_watchlists" USING btree ("workspace_id","project_id","id");--> statement-breakpoint
CREATE INDEX "research_watchlists_due_idx" ON "research_watchlists" USING btree ("next_run_at") WHERE "research_watchlists"."next_run_at" is not null and "research_watchlists"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "health_checks_app_idx" ON "health_checks" USING btree ("app_id","id");--> statement-breakpoint
CREATE INDEX "health_checks_incident_idx" ON "health_checks" USING btree ("incident_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "incident_triages_incident_uq" ON "incident_triages" USING btree ("incident_id");--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_active_fingerprint_uq" ON "incidents" USING btree ("fingerprint") WHERE "incidents"."status" <> 'RESOLVED';--> statement-breakpoint
CREATE INDEX "incidents_scope_idx" ON "incidents" USING btree ("workspace_id","project_id","id");--> statement-breakpoint
CREATE INDEX "incidents_app_idx" ON "incidents" USING btree ("app_id","id");--> statement-breakpoint
CREATE INDEX "monitored_apps_scope_idx" ON "monitored_apps" USING btree ("workspace_id","project_id","id");--> statement-breakpoint
CREATE INDEX "monitored_apps_due_idx" ON "monitored_apps" USING btree ("next_check_at") WHERE not "monitored_apps"."disabled";--> statement-breakpoint
-- FR-CWV-01: turns are the conversation record, never rewritten.
CREATE TRIGGER conversation_turns_append_only BEFORE UPDATE OR DELETE ON "conversation_turns"
  FOR EACH ROW EXECUTE FUNCTION nexus_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER conversation_turns_no_truncate BEFORE TRUNCATE ON "conversation_turns"
  FOR EACH STATEMENT EXECUTE FUNCTION nexus_forbid_mutation();
--> statement-breakpoint
-- FR-CXR-05: what the owner approves can't change under its hash; a changed action needs a new proposal.
CREATE FUNCTION nexus_freeze_proposal_action() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action IS DISTINCT FROM OLD.action OR NEW.action_hash IS DISTINCT FROM OLD.action_hash
     OR NEW.thread_id IS DISTINCT FROM OLD.thread_id THEN
    RAISE EXCEPTION 'proposal action is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER action_proposals_freeze_action BEFORE UPDATE ON "action_proposals"
  FOR EACH ROW EXECUTE FUNCTION nexus_freeze_proposal_action();
--> statement-breakpoint
CREATE TRIGGER action_proposals_no_delete BEFORE DELETE ON "action_proposals"
  FOR EACH ROW EXECUTE FUNCTION nexus_forbid_mutation();
--> statement-breakpoint
-- FR-WKS-05: profile versions are immutable; a change is a new version, so pinned conversations and plans keep theirs.
CREATE TRIGGER agent_profile_versions_append_only BEFORE UPDATE OR DELETE ON "agent_profile_versions"
  FOR EACH ROW EXECUTE FUNCTION nexus_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER agent_profile_versions_no_truncate BEFORE TRUNCATE ON "agent_profile_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION nexus_forbid_mutation();
