import pg from "pg";
import type { FastifyBaseLogger } from "fastify";
import { JOB_EVENTS_CHANNEL } from "./jobs.ts";

export const ANY_JOB = "*";
const RECONNECT_MS = 1_000;

/**
 * One dedicated LISTEN connection fanned out in-process. Payloads are job ids; subscribers re-read the DB,
 * so a notification is only a wake-up and nothing is lost if one is missed.
 */
export async function createHub(databaseUrl: string, log: FastifyBaseLogger) {
  const subs = new Map<string, Set<() => void>>();
  let client: pg.Client | null = null;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;

  const emit = (key: string) => subs.get(key)?.forEach((fn) => fn());
  const wakeAll = () => subs.forEach((set) => set.forEach((fn) => fn()));

  const scheduleReconnect = () => {
    if (closed) return;
    timer = setTimeout(() => {
      connect().catch((err: unknown) => {
        log.warn({ err }, "LISTEN reconnect failed");
        scheduleReconnect();
      });
    }, RECONNECT_MS);
  };

  async function connect() {
    const c = new pg.Client({ connectionString: databaseUrl });
    const lost = () => {
      if (client !== c) return;
      client = null;
      c.end().catch(() => {});
      log.warn("LISTEN connection lost; reconnecting");
      scheduleReconnect();
    };
    c.on("error", (err) => {
      log.error({ err }, "LISTEN connection error");
      lost();
    });
    c.on("end", lost);
    c.on("notification", (msg) => {
      if (msg.payload) emit(msg.payload);
      emit(ANY_JOB);
    });
    try {
      await c.connect();
      await c.query(`LISTEN ${JOB_EVENTS_CHANNEL}`);
    } catch (err) {
      c.end().catch(() => {});
      throw err;
    }
    client = c;
    wakeAll(); // re-read anything committed while we were disconnected
  }

  await connect();

  return {
    subscribe(key: string, fn: () => void): () => void {
      let set = subs.get(key);
      if (!set) subs.set(key, (set = new Set()));
      set.add(fn);
      return () => {
        set.delete(fn);
        if (set.size === 0) subs.delete(key);
      };
    },
    async close() {
      closed = true;
      clearTimeout(timer);
      const c = client;
      client = null;
      await c?.end();
    },
  };
}

export type Hub = Awaited<ReturnType<typeof createHub>>;
