CREATE TABLE "health_checks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"incident_id" uuid,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL,
	"status_code" integer,
	"latency_ms" integer,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"title" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"recovered_at" timestamp with time zone,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "monitored_apps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"environment" text NOT NULL,
	"health_url" text NOT NULL,
	"repository_id" text,
	"interval_seconds" integer NOT NULL,
	"timeout_ms" integer NOT NULL,
	"failure_threshold" integer NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "incident_id" uuid;--> statement-breakpoint
ALTER TABLE "health_checks" ADD CONSTRAINT "health_checks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_checks" ADD CONSTRAINT "health_checks_app_id_monitored_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."monitored_apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_checks" ADD CONSTRAINT "health_checks_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_app_id_monitored_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."monitored_apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_apps" ADD CONSTRAINT "monitored_apps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "health_checks_app_idx" ON "health_checks" USING btree ("app_id","id");--> statement-breakpoint
CREATE INDEX "health_checks_incident_idx" ON "health_checks" USING btree ("incident_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_active_fingerprint_uq" ON "incidents" USING btree ("fingerprint") WHERE "incidents"."status" <> 'RESOLVED';--> statement-breakpoint
CREATE INDEX "incidents_scope_idx" ON "incidents" USING btree ("workspace_id","project_id","id");--> statement-breakpoint
CREATE INDEX "incidents_app_idx" ON "incidents" USING btree ("app_id","id");--> statement-breakpoint
CREATE INDEX "monitored_apps_scope_idx" ON "monitored_apps" USING btree ("workspace_id","project_id","id");--> statement-breakpoint
CREATE INDEX "monitored_apps_due_idx" ON "monitored_apps" USING btree ("next_check_at") WHERE not "monitored_apps"."disabled";