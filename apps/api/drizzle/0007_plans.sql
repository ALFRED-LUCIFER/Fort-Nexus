CREATE TABLE "plan_steps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"title" text NOT NULL,
	"agent" text NOT NULL,
	"action" jsonb NOT NULL,
	"depends_on" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"blocked_reason" text,
	"job_id" uuid,
	"research_run_id" uuid,
	"artifact" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"goal" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"plan_hash" text,
	"profile_version_id" uuid,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "plan_steps" ADD CONSTRAINT "plan_steps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_steps" ADD CONSTRAINT "plan_steps_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_steps" ADD CONSTRAINT "plan_steps_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plan_steps_plan_index_uq" ON "plan_steps" USING btree ("plan_id","index");--> statement-breakpoint
CREATE INDEX "plan_steps_running_idx" ON "plan_steps" USING btree ("plan_id") WHERE "plan_steps"."status" = 'RUNNING';--> statement-breakpoint
CREATE INDEX "plan_steps_agent_idx" ON "plan_steps" USING btree ("project_id","agent");--> statement-breakpoint
CREATE UNIQUE INDEX "plans_owner_idempotency_uq" ON "plans" USING btree ("owner_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "plans_scope_idx" ON "plans" USING btree ("workspace_id","project_id","id");--> statement-breakpoint
CREATE INDEX "plans_active_idx" ON "plans" USING btree ("id") WHERE "plans"."status" in ('APPROVED', 'RUNNING');