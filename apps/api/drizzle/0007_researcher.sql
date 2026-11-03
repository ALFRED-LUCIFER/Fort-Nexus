CREATE TABLE "ai_spend" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_id" uuid NOT NULL,
	"reserved_usd" numeric(12, 6) NOT NULL,
	"cost_usd" numeric(12, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "ai_spend_source_valid" CHECK ("ai_spend"."source" in ('DEEP_DIVE')),
	CONSTRAINT "ai_spend_reserved_positive" CHECK ("ai_spend"."reserved_usd" > 0),
	CONSTRAINT "ai_spend_cost_nonnegative" CHECK ("ai_spend"."cost_usd" is null or "ai_spend"."cost_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "research_domains" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"tier" text NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_issue_previews" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"repository_id" text NOT NULL,
	"repository_full_name" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"labels" jsonb NOT NULL,
	"action_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_issue_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"repository_id" text NOT NULL,
	"repository_full_name" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"labels" jsonb NOT NULL,
	"action_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"issue_number" integer,
	"issue_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"deep_dive_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"problem" text NOT NULL,
	"target_users" text NOT NULL,
	"impact_estimate" text NOT NULL,
	"confidence" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"verified_claims" integer NOT NULL,
	"validation_steps" jsonb NOT NULL,
	"agents" jsonb NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"issue" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_deep_dive_steps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"deep_dive_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"kind" text NOT NULL,
	"detail" text NOT NULL,
	"outcome" text NOT NULL,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_deep_dives" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"correlation_id" text NOT NULL,
	"question" text NOT NULL,
	"depth" text NOT NULL,
	"finding_ids" jsonb NOT NULL,
	"status" text NOT NULL,
	"stopped_by" text,
	"limits" jsonb NOT NULL,
	"search_enabled" boolean NOT NULL,
	"model" text NOT NULL,
	"profile_version_id" uuid,
	"spend_id" uuid,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	"searches" integer DEFAULT 0 NOT NULL,
	"fetches" integer DEFAULT 0 NOT NULL,
	"report" jsonb,
	"opportunity_id" uuid,
	"error" text,
	"cancel_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "research_deep_dives_status_valid" CHECK ("research_deep_dives"."status" in ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "research_page_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"deep_dive_id" uuid NOT NULL,
	"url" text NOT NULL,
	"final_url" text NOT NULL,
	"title" text NOT NULL,
	"text" text NOT NULL,
	"sha256" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "research_run_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "deep_dive_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "opportunity_id" uuid;--> statement-breakpoint
ALTER TABLE "action_proposals" ADD COLUMN "result_deep_dive_id" uuid;--> statement-breakpoint
ALTER TABLE "plan_steps" ADD COLUMN "deep_dive_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_spend" ADD CONSTRAINT "ai_spend_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_spend" ADD CONSTRAINT "ai_spend_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_issue_previews" ADD CONSTRAINT "opportunity_issue_previews_opportunity_id_research_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."research_opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_issue_requests" ADD CONSTRAINT "opportunity_issue_requests_opportunity_id_research_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."research_opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_opportunities" ADD CONSTRAINT "research_opportunities_deep_dive_id_research_deep_dives_id_fk" FOREIGN KEY ("deep_dive_id") REFERENCES "public"."research_deep_dives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_deep_dive_steps" ADD CONSTRAINT "research_deep_dive_steps_deep_dive_id_research_deep_dives_id_fk" FOREIGN KEY ("deep_dive_id") REFERENCES "public"."research_deep_dives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_page_snapshots" ADD CONSTRAINT "research_page_snapshots_deep_dive_id_research_deep_dives_id_fk" FOREIGN KEY ("deep_dive_id") REFERENCES "public"."research_deep_dives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_spend_source_uq" ON "ai_spend" USING btree ("source","source_id");--> statement-breakpoint
CREATE INDEX "ai_spend_created_idx" ON "ai_spend" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "research_domains_workspace_domain_uq" ON "research_domains" USING btree ("workspace_id","domain");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_issue_previews_hash_uq" ON "opportunity_issue_previews" USING btree ("opportunity_id","action_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_issue_requests_opportunity_uq" ON "opportunity_issue_requests" USING btree ("opportunity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_opportunities_deep_dive_uq" ON "research_opportunities" USING btree ("deep_dive_id");--> statement-breakpoint
CREATE INDEX "research_opportunities_scope_idx" ON "research_opportunities" USING btree ("workspace_id","project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "research_deep_dive_steps_uq" ON "research_deep_dive_steps" USING btree ("deep_dive_id","index");--> statement-breakpoint
CREATE UNIQUE INDEX "research_deep_dives_idempotency_uq" ON "research_deep_dives" USING btree ("project_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "research_deep_dives_scope_idx" ON "research_deep_dives" USING btree ("workspace_id","project_id","id");--> statement-breakpoint
CREATE INDEX "research_deep_dives_active_idx" ON "research_deep_dives" USING btree ("status","id") WHERE "research_deep_dives"."status" in ('QUEUED', 'RUNNING');--> statement-breakpoint
CREATE UNIQUE INDEX "research_page_snapshots_url_uq" ON "research_page_snapshots" USING btree ("deep_dive_id","url");--> statement-breakpoint
-- A deep dive's step log is append-only (like run_events): reject UPDATE, DELETE and TRUNCATE at the database.
CREATE TRIGGER research_deep_dive_steps_append_only BEFORE UPDATE OR DELETE ON "research_deep_dive_steps"
  FOR EACH ROW EXECUTE FUNCTION nexus_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER research_deep_dive_steps_no_truncate BEFORE TRUNCATE ON "research_deep_dive_steps"
  FOR EACH STATEMENT EXECUTE FUNCTION nexus_forbid_mutation();
