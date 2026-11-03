CREATE TABLE "job_drafts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text NOT NULL,
	"text" text NOT NULL,
	"kind" text,
	"repository_id" text,
	"repository_full_name" text,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"issue_title" text,
	"issue_body" text,
	"issue_number" integer,
	"budget" jsonb NOT NULL,
	"unsupported_reason" text,
	"preview_hash" text,
	"preview" jsonb,
	"preview_runner_id" uuid,
	"preview_expires_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"attempt" integer DEFAULT 0 NOT NULL,
	"approve_idempotency_key" text,
	"approve_hash" text,
	"created_issue_number" integer,
	"created_issue_url" text,
	"job_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_drafts" ADD CONSTRAINT "job_drafts_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_drafts" ADD CONSTRAINT "job_drafts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_drafts_owner_key_uq" ON "job_drafts" USING btree ("owner_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "job_drafts_project_idx" ON "job_drafts" USING btree ("project_id","id");