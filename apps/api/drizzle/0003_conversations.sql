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
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."conversation_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_turn_id_conversation_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."conversation_turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_result_job_id_jobs_id_fk" FOREIGN KEY ("result_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_threads" ADD CONSTRAINT "conversation_threads_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_threads" ADD CONSTRAINT "conversation_threads_subject_job_id_jobs_id_fk" FOREIGN KEY ("subject_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."conversation_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_proposals_thread_idx" ON "action_proposals" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "conversation_threads_scope_idx" ON "conversation_threads" USING btree ("workspace_id","project_id","owner_id","id");--> statement-breakpoint
CREATE INDEX "conversation_turns_thread_idx" ON "conversation_turns" USING btree ("thread_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_turns_idempotency_uq" ON "conversation_turns" USING btree ("thread_id","idempotency_key") WHERE "conversation_turns"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_turns_reply_uq" ON "conversation_turns" USING btree ("reply_to") WHERE "conversation_turns"."reply_to" is not null;--> statement-breakpoint
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