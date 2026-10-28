CREATE TABLE "project_repositories" (
	"project_id" uuid NOT NULL,
	"repository_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_repositories_project_id_repository_id_pk" PRIMARY KEY("project_id","repository_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_id" text NOT NULL,
	"mode" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_mode_valid" CHECK ("workspaces"."mode" in ('DEV', 'BUSINESS'))
);
--> statement-breakpoint
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_workspace_slug_uq" ON "projects" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_owner_mode_uq" ON "workspaces" USING btree ("owner_id","mode");--> statement-breakpoint
-- Legacy rows: every owner gets Dev + Business; existing jobs/approvals move into the Dev project "home",
-- bound to every repository those jobs used. Columns become NOT NULL only after the backfill.
ALTER TABLE "approvals" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "project_id" uuid;--> statement-breakpoint
INSERT INTO "workspaces" ("owner_id", "mode", "name")
  SELECT u."id", m."mode", m."name" FROM "user" u CROSS JOIN (VALUES ('DEV', 'Dev'), ('BUSINESS', 'Business')) AS m("mode", "name");
--> statement-breakpoint
INSERT INTO "projects" ("workspace_id", "slug", "name") SELECT "id", 'home', 'Home' FROM "workspaces" WHERE "mode" = 'DEV';
--> statement-breakpoint
UPDATE "jobs" SET "project_id" = p."id"
  FROM "projects" p JOIN "workspaces" w ON w."id" = p."workspace_id"
  WHERE w."owner_id" = "jobs"."initiator_id" AND w."mode" = 'DEV' AND p."slug" = 'home';
--> statement-breakpoint
UPDATE "approvals" SET "project_id" = j."project_id" FROM "jobs" j WHERE j."id" = "approvals"."job_id";
--> statement-breakpoint
INSERT INTO "project_repositories" ("project_id", "repository_id")
  SELECT DISTINCT "project_id", "request"->>'repositoryId' FROM "jobs"
  WHERE "job_type" = 'DEV_ISSUE_TO_PR' AND "request"->>'repositoryId' IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_project_idx" ON "approvals" USING btree ("project_id","id");--> statement-breakpoint
CREATE INDEX "jobs_project_id_idx" ON "jobs" USING btree ("project_id","id");--> statement-breakpoint
-- An approval's project is as immutable as its action (SEC-G04, NFR-CNV-05).
CREATE OR REPLACE FUNCTION nexus_freeze_approval_action() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action IS DISTINCT FROM OLD.action OR NEW.action_hash IS DISTINCT FROM OLD.action_hash
     OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'approval action is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
