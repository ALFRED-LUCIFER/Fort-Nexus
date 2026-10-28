CREATE TABLE "system_controls" (
	"id" integer PRIMARY KEY NOT NULL,
	"emergency_stop_engaged" boolean DEFAULT false NOT NULL,
	"emergency_stop_changed_at" timestamp with time zone,
	"daily_budget_usd" numeric(12, 6) DEFAULT 20 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_controls_singleton" CHECK ("system_controls"."id" = 1),
	CONSTRAINT "system_controls_budget_positive" CHECK ("system_controls"."daily_budget_usd" > 0)
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "estimated_cost_usd" numeric(12, 6);--> statement-breakpoint
-- The single controls row; defaults are the shipped safety settings ($20/day, stop released).
INSERT INTO "system_controls" ("id") VALUES (1) ON CONFLICT DO NOTHING;
