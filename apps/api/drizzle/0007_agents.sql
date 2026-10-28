CREATE TABLE "agent_profile_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"agent" text NOT NULL,
	"version" integer NOT NULL,
	"settings" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_profile_versions_uq" UNIQUE NULLS NOT DISTINCT("agent","workspace_id","project_id","version")
);
--> statement-breakpoint
ALTER TABLE "conversation_threads" ADD COLUMN "profile_version_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_profile_versions" ADD CONSTRAINT "agent_profile_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profile_versions" ADD CONSTRAINT "agent_profile_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_threads" ADD CONSTRAINT "conversation_threads_profile_version_id_agent_profile_versions_id_fk" FOREIGN KEY ("profile_version_id") REFERENCES "public"."agent_profile_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- FR-WKS-05: profile versions are immutable; a change is a new version, so pinned conversations and plans keep theirs.
CREATE TRIGGER agent_profile_versions_append_only BEFORE UPDATE OR DELETE ON "agent_profile_versions"
  FOR EACH ROW EXECUTE FUNCTION nexus_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER agent_profile_versions_no_truncate BEFORE TRUNCATE ON "agent_profile_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION nexus_forbid_mutation();