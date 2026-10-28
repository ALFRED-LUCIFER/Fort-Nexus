CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" uuid,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"job_id" uuid,
	"approval_id" uuid,
	"dedup_key" text NOT NULL,
	"status" text DEFAULT 'UNREAD' NOT NULL,
	"status_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_dedup_key_unique" UNIQUE("dedup_key"),
	CONSTRAINT "notifications_category_valid" CHECK ("notifications"."category" in ('INFORMATIONAL', 'TASK_DONE', 'TASK_FAILED', 'APPROVAL_REQUIRED', 'BUSINESS_EXCEPTION', 'SECURITY_CRITICAL')),
	CONSTRAINT "notifications_status_valid" CHECK ("notifications"."status" in ('UNREAD', 'READ', 'ACKNOWLEDGED'))
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_owner_idx" ON "notifications" USING btree ("owner_id","id");--> statement-breakpoint
CREATE INDEX "notifications_owner_unread_idx" ON "notifications" USING btree ("owner_id") WHERE "notifications"."status" = 'UNREAD';