import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

// One container per run; each test file creates its own database from it (see test/helpers.ts).
export default async function setup(project: TestProject) {
  const container = await new PostgreSqlContainer("postgres:18-alpine").start();
  project.provide("pgAdminUrl", container.getConnectionUri());
  return () => container.stop();
}
