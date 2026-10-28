import { once } from "node:events";
import { PassThrough } from "node:stream";
import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { SSE_RUN_EVENT, isTerminal } from "@nexus/contracts";
import { jobs } from "./db/schema.ts";
import type { Db } from "./db/index.ts";
import { eventsAfter, toRunEventDto } from "./jobs.ts";
import type { Hub } from "./notify.ts";

const PAGE = 500;
const PING_MS = 15_000;

/**
 * Replays events with sequence > cursor, then streams live ones (woken by LISTEN/NOTIFY, read from the DB so
 * order and completeness come from run_events). Sends `event: end` and closes once the job is terminal and
 * fully replayed. Read-only: reconnecting can never start another execution (GATE-04).
 */
export function streamJobEvents(
  deps: { db: Db; hub: Hub; shutdown: AbortSignal },
  request: FastifyRequest,
  reply: FastifyReply,
  jobId: string,
  afterSequence: number,
) {
  const stream = new PassThrough();
  const stop = new AbortController();
  let cursor = afterSequence;
  let done = false;
  let chain = Promise.resolve();

  const write = async (chunk: string) => {
    if (!done && !stream.write(chunk)) await once(stream, "drain", { signal: stop.signal });
  };

  const flush = async () => {
    // Read the job first: anything it counts as written is already visible to the events query below.
    const [job] = await deps.db
      .select({ status: jobs.status, last: jobs.lastEventSequence })
      .from(jobs)
      .where(eq(jobs.id, jobId));
    for (;;) {
      const batch = await eventsAfter(deps.db, jobId, cursor, PAGE);
      for (const e of batch) {
        await write(
          `id: ${e.sequence}\nevent: ${SSE_RUN_EVENT}\ndata: ${JSON.stringify(toRunEventDto(e))}\n\n`,
        );
        cursor = e.sequence;
      }
      if (done || batch.length < PAGE) break;
    }
    if (job && isTerminal(job.status) && cursor >= job.last) {
      await write(`event: end\ndata: ${JSON.stringify({ status: job.status, lastSequence: cursor })}\n\n`);
      finish();
    }
  };

  const wake = () => {
    chain = chain.then(flush).catch((err: unknown) => {
      if (done) return;
      request.log.error({ err, jobId }, "SSE flush failed");
      finish();
    });
  };

  const unsubscribe = deps.hub.subscribe(jobId, wake);
  const ping = setInterval(() => write(": ping\n\n").catch(() => {}), PING_MS);

  function finish() {
    if (done) return;
    done = true;
    unsubscribe();
    clearInterval(ping);
    deps.shutdown.removeEventListener("abort", finish);
    stop.abort();
    stream.end();
  }

  deps.shutdown.addEventListener("abort", finish);
  reply.raw.on("close", finish);
  stream.on("close", finish);

  void reply
    .header("content-type", "text/event-stream; charset=utf-8")
    .header("cache-control", "no-cache, no-transform")
    .header("x-accel-buffering", "no")
    .send(stream);
  wake();
  return reply;
}
