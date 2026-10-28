CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"job_id" uuid NOT NULL,
	"risk_tier" text NOT NULL,
	"status" text NOT NULL,
	"action" jsonb NOT NULL,
	"action_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"result" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "changesets" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"runner_id" uuid NOT NULL,
	"fencing_token" integer NOT NULL,
	"base_sha" text NOT NULL,
	"sha256" text NOT NULL,
	"files" jsonb NOT NULL,
	"stats" jsonb NOT NULL,
	"agent_summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_actions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"idempotency_key" text NOT NULL,
	"job_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"status" text NOT NULL,
	"commit_sha" text,
	"external_id" text,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_actions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "issue_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changesets" ADD CONSTRAINT "changesets_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changesets" ADD CONSTRAINT "changesets_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_actions" ADD CONSTRAINT "external_actions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_actions" ADD CONSTRAINT "external_actions_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_job_idx" ON "approvals" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "approvals_status_idx" ON "approvals" USING btree ("status","expires_at");--> statement-breakpoint
-- A changeset is evidence of what was approved: never changed after upload.
CREATE TRIGGER changesets_append_only BEFORE UPDATE OR DELETE ON "changesets"
  FOR EACH ROW EXECUTE FUNCTION nexus_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER changesets_no_truncate BEFORE TRUNCATE ON "changesets"
  FOR EACH STATEMENT EXECUTE FUNCTION nexus_forbid_mutation();
--> statement-breakpoint
-- SEC-G04: an approval's action can't change under it; a changed action needs a new approval.
CREATE FUNCTION nexus_freeze_approval_action() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action IS DISTINCT FROM OLD.action OR NEW.action_hash IS DISTINCT FROM OLD.action_hash
     OR NEW.job_id IS DISTINCT FROM OLD.job_id THEN
    RAISE EXCEPTION 'approval action is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER approvals_freeze_action BEFORE UPDATE ON "approvals"
  FOR EACH ROW EXECUTE FUNCTION nexus_freeze_approval_action();
--> statement-breakpoint
CREATE TRIGGER approvals_no_delete BEFORE DELETE ON "approvals"
  FOR EACH ROW EXECUTE FUNCTION nexus_forbid_mutation();
