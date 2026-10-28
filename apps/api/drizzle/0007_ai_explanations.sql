CREATE TABLE "research_finding_explanations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"model" text NOT NULL,
	"profile_version_id" uuid,
	"claimed_at" timestamp with time zone NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "incident_triages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"model" text NOT NULL,
	"profile_version_id" uuid,
	"claimed_at" timestamp with time zone NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "research_finding_explanations" ADD CONSTRAINT "research_finding_explanations_finding_id_research_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."research_findings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_triages" ADD CONSTRAINT "incident_triages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_triages" ADD CONSTRAINT "incident_triages_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "research_finding_explanations_finding_uq" ON "research_finding_explanations" USING btree ("finding_id");--> statement-breakpoint
CREATE UNIQUE INDEX "incident_triages_incident_uq" ON "incident_triages" USING btree ("incident_id");