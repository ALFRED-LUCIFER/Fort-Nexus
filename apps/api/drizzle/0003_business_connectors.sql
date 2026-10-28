CREATE TABLE "business_connectors" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"environment" text NOT NULL,
	"credential_ref" text NOT NULL,
	"schema_allowlist" jsonb NOT NULL,
	"statement_timeout_ms" integer NOT NULL,
	"status" text NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_error" text,
	"dictionary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "business_connectors_scope_idx" ON "business_connectors" USING btree ("workspace_id","project_id","id");