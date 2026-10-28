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
ALTER TABLE "research_finding_sources" ADD CONSTRAINT "research_finding_sources_finding_id_research_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."research_findings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_finding_sources" ADD CONSTRAINT "research_finding_sources_watchlist_id_research_watchlists_id_fk" FOREIGN KEY ("watchlist_id") REFERENCES "public"."research_watchlists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_findings" ADD CONSTRAINT "research_findings_watchlist_id_research_watchlists_id_fk" FOREIGN KEY ("watchlist_id") REFERENCES "public"."research_watchlists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_findings" ADD CONSTRAINT "research_findings_first_run_id_research_runs_id_fk" FOREIGN KEY ("first_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_watchlist_id_research_watchlists_id_fk" FOREIGN KEY ("watchlist_id") REFERENCES "public"."research_watchlists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
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
CREATE INDEX "research_watchlists_due_idx" ON "research_watchlists" USING btree ("next_run_at") WHERE "research_watchlists"."next_run_at" is not null and "research_watchlists"."archived_at" is null;