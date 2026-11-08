ALTER TABLE "approvals" ADD COLUMN "push_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "retry_at" timestamp with time zone;