import { randomBytes, randomInt } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import {
  runnerStatus,
  type PairingCodeResponse,
  type Runner,
  type RunnerRegisterRequest,
  type RunnerRegisterResponse,
} from "@nexus/contracts";
import { audit } from "./audit.ts";
import type { Db } from "./db/index.ts";
import { runnerPairingCodes, runners } from "./db/schema.ts";
import { HttpError, notFound } from "./errors.ts";
import { ownerActor, runnerActor, sha256 } from "./jobs.ts";

export type RunnerRow = typeof runners.$inferSelect;

const PAIRING_TTL_MS = 10 * 60_000;
// Unambiguous uppercase alphabet (no 0/O, 1/I/L, U) — the code is typed by hand.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const normalizeCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, "");

export const toRunnerDto = (r: RunnerRow, now = new Date()): Runner => ({
  id: r.id,
  name: r.name,
  os: r.os,
  version: r.version,
  capacity: r.capacity,
  status: runnerStatus(r.lastHeartbeatAt, r.revokedAt !== null, now),
  lastHeartbeatAt: r.lastHeartbeatAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
});

export async function listRunners(db: Db, ownerId: string): Promise<Runner[]> {
  const rows = await db.select().from(runners).where(eq(runners.ownerId, ownerId)).orderBy(desc(runners.id));
  const now = new Date();
  return rows.map((r) => toRunnerDto(r, now));
}

/** One-time pairing code (~49 bits, 10 min). Only its hash is stored. */
export async function createPairingCode(
  db: Db,
  input: { ownerId: string; correlationId: string },
): Promise<PairingCodeResponse> {
  const raw = Array.from({ length: 10 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(runnerPairingCodes)
      .values({ ownerId: input.ownerId, codeHash: sha256(raw), expiresAt })
      .returning({ id: runnerPairingCodes.id });
    await audit(tx, {
      actor: ownerActor(input.ownerId),
      action: "runner.pair",
      resourceType: "runner",
      resourceId: row!.id, // pairing-code id; the runner id exists only after register
      correlationId: input.correlationId,
      metadata: { expiresAt: expiresAt.toISOString() },
    });
  });
  return { code: `${raw.slice(0, 5)}-${raw.slice(5)}`, expiresAt: expiresAt.toISOString() };
}

export async function registerRunner(
  db: Db,
  input: RunnerRegisterRequest & { correlationId: string },
): Promise<RunnerRegisterResponse> {
  const token = `nxr_${randomBytes(32).toString("base64url")}`;
  return db.transaction(async (tx) => {
    const [code] = await tx
      .select()
      .from(runnerPairingCodes)
      .where(
        and(
          eq(runnerPairingCodes.codeHash, sha256(normalizeCode(input.code))),
          isNull(runnerPairingCodes.usedAt),
          gt(runnerPairingCodes.expiresAt, new Date()),
        ),
      )
      .for("update");
    if (!code) throw new HttpError(401, "UNAUTHENTICATED", "Pairing code is invalid, used or expired");
    const [runner] = await tx
      .insert(runners)
      .values({
        ownerId: code.ownerId,
        name: input.name,
        os: input.os,
        version: input.version,
        capacity: input.capacity,
        tokenHash: sha256(token),
      })
      .returning();
    await tx
      .update(runnerPairingCodes)
      .set({ usedAt: new Date(), runnerId: runner!.id })
      .where(eq(runnerPairingCodes.id, code.id));
    await audit(tx, {
      actor: runnerActor(runner!.id),
      action: "runner.register",
      resourceType: "runner",
      resourceId: runner!.id,
      correlationId: input.correlationId,
      metadata: { name: input.name, os: input.os, version: input.version, pairingCodeId: code.id },
    });
    return { runnerId: runner!.id, token };
  });
}

export async function revokeRunner(
  db: Db,
  input: { ownerId: string; runnerId: string; correlationId: string },
): Promise<Runner> {
  return db.transaction(async (tx) => {
    const [runner] = await tx
      .select()
      .from(runners)
      .where(and(eq(runners.id, input.runnerId), eq(runners.ownerId, input.ownerId)))
      .for("update");
    if (!runner) throw notFound("Runner");
    if (runner.revokedAt) return toRunnerDto(runner);
    const [revoked] = await tx
      .update(runners)
      .set({ revokedAt: new Date() })
      .where(eq(runners.id, runner.id))
      .returning();
    await audit(tx, {
      actor: ownerActor(input.ownerId),
      action: "runner.revoke",
      resourceType: "runner",
      resourceId: runner.id,
      correlationId: input.correlationId,
    });
    return toRunnerDto(revoked!);
  });
}

/** Bearer token → active runner, or null when unknown or revoked. */
export async function authenticateRunner(db: Db, token: string): Promise<RunnerRow | null> {
  const [runner] = await db
    .select()
    .from(runners)
    .where(eq(runners.tokenHash, sha256(token)));
  return runner && !runner.revokedAt ? runner : null;
}
