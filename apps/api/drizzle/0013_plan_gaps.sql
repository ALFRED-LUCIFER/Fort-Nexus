ALTER TABLE "plan_steps" ADD COLUMN "why" text;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "gaps" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "dropped" jsonb DEFAULT '[]'::jsonb NOT NULL;