ALTER TABLE "jobs" ADD COLUMN "retry_of_job_id" uuid;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "remote_access" jsonb;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "remote_access_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_retry_of_job_id_jobs_id_fk" FOREIGN KEY ("retry_of_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;