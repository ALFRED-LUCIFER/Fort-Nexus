CREATE TABLE "voice_settings" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"mic_enabled" boolean NOT NULL,
	"speak_replies" boolean NOT NULL,
	"speech_rate" double precision NOT NULL,
	"language" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_settings_rate_range" CHECK ("voice_settings"."speech_rate" between 0.75 and 1.5)
);
--> statement-breakpoint
CREATE TABLE "voice_usage" (
	"owner_id" text NOT NULL,
	"local_date" date NOT NULL,
	"transcribed_seconds" numeric(12, 3) DEFAULT 0 NOT NULL,
	"spoken_characters" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "voice_usage_owner_id_local_date_pk" PRIMARY KEY("owner_id","local_date"),
	CONSTRAINT "voice_usage_nonnegative" CHECK ("voice_usage"."transcribed_seconds" >= 0 and "voice_usage"."spoken_characters" >= 0)
);
--> statement-breakpoint
ALTER TABLE "voice_settings" ADD CONSTRAINT "voice_settings_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_usage" ADD CONSTRAINT "voice_usage_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;