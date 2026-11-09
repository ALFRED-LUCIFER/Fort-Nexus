CREATE TABLE "job_feedback" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"job_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"text" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"delivered_round" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "changesets" ADD COLUMN "verification" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "continues_changeset" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "owner_note" text;--> statement-breakpoint
ALTER TABLE "job_feedback" ADD CONSTRAINT "job_feedback_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_feedback" ADD CONSTRAINT "job_feedback_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_feedback_owner_idempotency_key_uq" ON "job_feedback" USING btree ("owner_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "job_feedback_job_idx" ON "job_feedback" USING btree ("job_id","created_at");