ALTER TABLE "ai_spend" DROP CONSTRAINT "ai_spend_source_valid";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "agent" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
-- Backfill (hand-written): a plan step's agent, else the job type's default; times from the job's own state events.
UPDATE "jobs" j SET "agent" = coalesce(
  (SELECT s."agent" FROM "plan_steps" s WHERE s."job_id" = j."id" ORDER BY s."index" LIMIT 1),
  CASE WHEN j."job_type" = 'DEV_ISSUE_TO_PR' THEN 'DEVELOPER' ELSE 'DEVOPS' END
);--> statement-breakpoint
UPDATE "jobs" j SET
  "started_at" = (SELECT min(e."occurred_at") FROM "run_events" e
    WHERE e."job_id" = j."id" AND e."type" = 'job.state.changed' AND e."payload"->>'to' = 'PREPARING'),
  "finished_at" = CASE WHEN j."status" IN ('COMPLETED', 'FAILED', 'CANCELLED', 'REJECTED', 'EXPIRED') THEN
    coalesce((SELECT max(e."occurred_at") FROM "run_events" e
      WHERE e."job_id" = j."id" AND e."type" = 'job.state.changed' AND e."payload"->>'to' = j."status"), j."updated_at")
  END;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "agent" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "jobs_initiator_agent_idx" ON "jobs" USING btree ("initiator_id","agent","created_at");--> statement-breakpoint
ALTER TABLE "ai_spend" ADD CONSTRAINT "ai_spend_source_valid" CHECK ("ai_spend"."source" in ('DEEP_DIVE', 'JOB_DRAFT'));
