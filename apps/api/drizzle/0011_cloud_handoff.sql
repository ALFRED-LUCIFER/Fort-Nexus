CREATE TABLE "cloud_handoff_previews" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"repository_id" text NOT NULL,
	"repository_full_name" text NOT NULL,
	"issue_number" integer NOT NULL,
	"routine_id" text NOT NULL,
	"text" text NOT NULL,
	"action_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"repository_id" text NOT NULL,
	"repository_full_name" text NOT NULL,
	"issue_number" integer NOT NULL,
	"routine_id" text NOT NULL,
	"text" text NOT NULL,
	"action_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"confirm_resend" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"locked_until" timestamp with time zone,
	"session_id" text,
	"session_url" text,
	"error" text,
	"retry_after_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_handoff_previews_hash_uq" ON "cloud_handoff_previews" USING btree ("project_id","repository_id","issue_number","action_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_handoffs_idempotency_uq" ON "cloud_handoffs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "cloud_handoffs_issue_idx" ON "cloud_handoffs" USING btree ("project_id","repository_id","issue_number","id");