import { defineConfig } from "drizzle-kit";

// Generation only reads the schema; DATABASE_URL is needed just for drizzle-kit's optional introspection commands.
export default defineConfig({
  dialect: "postgresql",
  schema: [
    "./src/db/schema.ts",
    "./src/business/schema.ts",
    "./src/conversations/schema.ts",
    "./src/research/schema.ts",
    "./src/monitoring/schema.ts",
  ],
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://nexus:nexus@127.0.0.1:5432/nexus" },
});
