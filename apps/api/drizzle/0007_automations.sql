CREATE TABLE "automation_clients" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"allowed_actions" jsonb NOT NULL,
	"allowed_job_types" jsonb NOT NULL,
	"rate_limit_per_minute" integer NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"client_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"action" text,
	"idempotency_key" text,
	"request_hash" text,
	"status" text NOT NULL,
	"reason" text,
	"result" jsonb,
	"correlation_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_clients" ADD CONSTRAINT "automation_clients_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_client_id_automation_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."automation_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_clients_scope_idx" ON "automation_clients" USING btree ("workspace_id","project_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_accepted_key_uq" ON "automation_runs" USING btree ("client_id","idempotency_key") WHERE "automation_runs"."status" = 'ACCEPTED';--> statement-breakpoint
CREATE INDEX "automation_runs_client_idx" ON "automation_runs" USING btree ("client_id","id");--> statement-breakpoint
CREATE INDEX "automation_runs_scope_idx" ON "automation_runs" USING btree ("workspace_id","project_id","id");