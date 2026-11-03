ALTER TABLE "action_proposals" ADD COLUMN "result_deep_dive_id" uuid;--> statement-breakpoint
ALTER TABLE "plan_steps" ADD COLUMN "deep_dive_id" uuid;