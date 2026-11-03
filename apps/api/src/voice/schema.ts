import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  doublePrecision,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { user } from "../db/schema.ts";

// Cofounder wave B (FR-CWV-02/03, FR-CSP-05, PRD §15): the owner's voice consent settings and per-day usage
// counters. Neither table ever holds audio, a transcript or spoken text.

export const voiceSettings = pgTable(
  "voice_settings",
  {
    ownerId: text("owner_id")
      .primaryKey()
      .references(() => user.id),
    micEnabled: boolean("mic_enabled").notNull(),
    speakReplies: boolean("speak_replies").notNull(),
    speechRate: doublePrecision("speech_rate").notNull(),
    language: text("language").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [check("voice_settings_rate_range", sql`${t.speechRate} between 0.75 and 1.5`)],
);

/** One row per owner and local day (config.ownerTimezone); counters only grow. */
export const voiceUsage = pgTable(
  "voice_usage",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id),
    localDate: date("local_date", { mode: "string" }).notNull(),
    transcribedSeconds: numeric("transcribed_seconds", { precision: 12, scale: 3, mode: "number" })
      .notNull()
      .default(0),
    spokenCharacters: integer("spoken_characters").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.localDate] }),
    check("voice_usage_nonnegative", sql`${t.transcribedSeconds} >= 0 and ${t.spokenCharacters} >= 0`),
  ],
);
