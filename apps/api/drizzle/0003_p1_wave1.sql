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
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."conversation_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_turn_id_conversation_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."conversation_turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_result_job_id_jobs_id_fk" FOREIGN KEY ("result_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_threads" ADD CONSTRAINT "conversation_threads_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_threads" ADD CONSTRAINT "conversation_threads_subject_job_id_jobs_id_fk" FOREIGN KEY ("subject_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."conversation_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_finding_sources" ADD CONSTRAINT "research_finding_sources_finding_id_research_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."research_findings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_finding_sources" ADD CONSTRAINT "research_finding_sources_watchlist_id_research_watchlists_id_fk" FOREIGN KEY ("watchlist_id") REFERENCES "public"."research_watchlists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_findings" ADD CONSTRAINT "research_findings_watchlist_id_research_watchlists_id_fk" FOREIGN KEY ("watchlist_id") REFERENCES "public"."research_watchlists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_findings" ADD CONSTRAINT "research_findings_first_run_id_research_runs_id_fk" FOREIGN KEY ("first_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_watchlist_id_research_watchlists_id_fk" FOREIGN KEY ("watchlist_id") REFERENCES "public"."research_watchlists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "business_connectors_scope_idx" ON "business_connectors" USING btree ("workspace_id","project_id","id");--> statement-breakpoint
CREATE INDEX "action_proposals_thread_idx" ON "action_proposals" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "conversation_threads_scope_idx" ON "conversation_threads" USING btree ("workspace_id","project_id","owner_id","id");--> statement-breakpoint
CREATE INDEX "conversation_turns_thread_idx" ON "conversation_turns" USING btree ("thread_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_turns_idempotency_uq" ON "conversation_turns" USING btree ("thread_id","idempotency_key") WHERE "conversation_turns"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_turns_reply_uq" ON "conversation_turns" USING btree ("reply_to") WHERE "conversation_turns"."reply_to" is not null;--> statement-breakpoint
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