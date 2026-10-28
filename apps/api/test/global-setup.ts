import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

// One container per run; each test file creates its own database from it (see test/helpers.ts).
export default async function setup(project: TestProject) {
  // Test files run in parallel, each with an API pool (10) plus helper pools and LISTEN clients: the default
  // max_connections (100) runs out once enough modules are under test.
  const container = await new PostgreSqlContainer("postgres:18-alpine")
    .withCommand(["postgres", "-c", "max_connections=500"])
    .start();
  project.provide("pgAdminUrl", container.getConnectionUri());
  return () => container.stop();
}
