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
ALTER TABLE "opportunity_issue_previews" ADD CONSTRAINT "opportunity_issue_previews_opportunity_id_research_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."research_opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_issue_requests" ADD CONSTRAINT "opportunity_issue_requests_opportunity_id_research_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."research_opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_issue_previews_hash_uq" ON "opportunity_issue_previews" USING btree ("opportunity_id","action_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_issue_requests_opportunity_uq" ON "opportunity_issue_requests" USING btree ("opportunity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_opportunities_deep_dive_uq" ON "research_opportunities" USING btree ("deep_dive_id");--> statement-breakpoint
CREATE INDEX "research_opportunities_scope_idx" ON "research_opportunities" USING btree ("workspace_id","project_id","status");