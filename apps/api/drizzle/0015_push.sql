CREATE TABLE "notification_preferences" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"categories" jsonb NOT NULL,
	"quiet_hours" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"device_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"notification_id" uuid,
	"dedup_key" text NOT NULL,
	"status" text NOT NULL,
	"payload" jsonb NOT NULL,
	"urgent" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"digest_id" uuid,
	"last_error" text,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "push_deliveries_kind_valid" CHECK ("push_deliveries"."kind" in ('NOTIFICATION', 'DIGEST', 'TEST')),
	CONSTRAINT "push_deliveries_status_valid" CHECK ("push_deliveries"."status" in ('HELD', 'PENDING', 'SENDING', 'SENT', 'FAILED', 'DIGESTED', 'SKIPPED')),
	CONSTRAINT "push_deliveries_notification_kind" CHECK (("push_deliveries"."kind" = 'NOTIFICATION') = ("push_deliveries"."notification_id" is not null)),
	CONSTRAINT "push_deliveries_attempts_nonnegative" CHECK ("push_deliveries"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "push_devices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_id" text NOT NULL,
	"label" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"service" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active_since" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_sent_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "push_devices_endpoint_unique" UNIQUE("endpoint"),
	CONSTRAINT "push_devices_status_valid" CHECK ("push_devices"."status" in ('ACTIVE', 'REVOKED', 'GONE')),
	CONSTRAINT "push_devices_service_valid" CHECK ("push_devices"."service" in ('APPLE', 'GOOGLE', 'MOZILLA', 'MICROSOFT'))
);
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_device_id_push_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."push_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "push_deliveries_notification_device_uq" ON "push_deliveries" USING btree ("notification_id","device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "push_deliveries_device_dedup_uq" ON "push_deliveries" USING btree ("device_id","dedup_key");--> statement-breakpoint
CREATE INDEX "push_deliveries_due_idx" ON "push_deliveries" USING btree ("next_attempt_at") WHERE "push_deliveries"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "push_deliveries_held_idx" ON "push_deliveries" USING btree ("device_id") WHERE "push_deliveries"."status" = 'HELD';--> statement-breakpoint
CREATE INDEX "push_devices_owner_idx" ON "push_devices" USING btree ("owner_id","id");