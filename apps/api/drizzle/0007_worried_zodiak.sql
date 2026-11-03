CREATE TABLE "research_domains" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"tier" text NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "research_domains_workspace_domain_uq" ON "research_domains" USING btree ("workspace_id","domain");