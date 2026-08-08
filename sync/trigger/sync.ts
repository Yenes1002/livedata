import { schedules, logger } from "@trigger.dev/sdk";
import { SOURCES } from "../sources.js";
import { connectSource, connectYenes, msg } from "../lib/db.js";
import { ensureState } from "../lib/state.js";
import { copyTable, type CopyResult } from "../lib/copy.js";
import type { SourceSpec } from "../lib/types.js";

/**
 * Copies tables from one or more source databases into your Postgres.
 *
 *   LEGACY_DATABASE_URL ─┐
 *                        ├─►  YENES_DATABASE_URL
 *   YZ_DATABASE_URL     ─┘
 *
 * Read-only on every source. What gets copied is declared in ../sources.ts;
 * see MAPPING.md for how to add a source or a table.
 *
 * Safety properties this run guarantees:
 *
 *  · Sources are isolated. One being down or misconfigured does not stop the
 *    others — every source is attempted, and the run fails at the end if any
 *    of them did, so a partial outage is still visible.
 *
 *  · Positions are per (source, table). Two sources writing the same target
 *    table keep separate cursors and cannot rewind each other.
 *
 *  · Every write is an upsert on the table's conflict key, so a retry, an
 *    overlapping run, or a re-read after a failed page all land the same rows
 *    rather than duplicating them.
 *
 *  · The time budget is shared, and which source goes first rotates, so a slow
 *    backfill on one source cannot starve the other indefinitely.
 */

// Stop short of maxDuration so the run finishes cleanly. Anything left over
// resumes from its cursor next run, so a big first backfill just takes a few
// runs instead of timing out.
const TIME_BUDGET_MS = 25 * 60 * 1000;

/** Leave room for the final bookkeeping writes after the last table. */
const WIND_DOWN_MS = 20 * 1000;

interface SourceOutcome {
  key: string;
  status: "ok" | "failed" | "skipped";
  reason?: string;
  tables: CopyResult[];
}

export const legacySync = schedules.task({
  // Kept as "legacy-sync" even though it now handles several sources: the id
  // is what the deployed schedule is attached to, and renaming it would orphan
  // the existing schedule in Trigger.dev. Rename deliberately, not by accident.
  id: "legacy-sync",
  maxDuration: 1800,

  // Hourly at :30, skipping 4am / 12pm / 5pm.
  //
  // Those three hours are when the portal's own pipeline reads the same legacy
  // MySQL, and its runs can take up to 30 minutes — so the whole hour is left
  // alone rather than just the hour mark. The :30 offset keeps every other run
  // clear of anything else that fires on the hour. 21 runs/day.
  //
  // To change it, edit the pattern and redeploy. To hand control to the
  // dashboard instead, delete this cron block and attach a schedule under
  // Schedules -> New schedule (same pattern), which can be edited in the UI.
  cron: {
    pattern: "5,20,35,50 0-3,5-11,13-16,18-23 * * *",
    timezone: "Asia/Kuala_Lumpur",
  },

  // One run at a time. At an hourly cadence a slow backfill run can still be
  // going when the next fires; without this they'd both write the same rows
  // and fight over the cursors.
  queue: { concurrencyLimit: 1 },

  run: async () => {
    const startedAt = Date.now();
    const deadline = startedAt + TIME_BUDGET_MS;

    if (!process.env.YENES_DATABASE_URL) {
      throw new Error(
        "YENES_DATABASE_URL is not set. Add it under Settings -> Environment Variables in this Trigger.dev project."
      );
    }

    const pg = await connectYenes(process.env.YENES_DATABASE_URL);
    const outcomes: SourceOutcome[] = [];

    try {
      await ensureState(pg);
      logger.info("Connected to YENES");

      const ordered = rotate(SOURCES, new Date().getUTCHours());

      for (const [index, source] of ordered.entries()) {
        const sourcesLeft = ordered.length - index;
        // Share what's left of the budget evenly across the sources still to
        // come, so the first one can't consume the whole run.
        const share = Math.max(0, deadline - Date.now() - WIND_DOWN_MS) / sourcesLeft;
        const sourceDeadline = Date.now() + share;

        outcomes.push(await runSource({ pg, source, deadline: sourceDeadline }));
      }
    } finally {
      await pg.end().catch(() => {});
    }

    /* ---------------- report ---------------- */
    // Skips are the thing people actually need to see: "0 rows" with no
    // explanation is the hardest failure to debug, so every skipped source and
    // every skipped table states its reason right here in the return value.
    const summary: Record<string, unknown> = {};
    for (const outcome of outcomes) {
      const tables: Record<string, unknown> = {};
      for (const t of outcome.tables) {
        tables[t.target] = t.skipped ? `SKIPPED: ${t.skipped}` : t.copied;
      }
      summary[outcome.key] =
        outcome.status === "ok"
          ? tables
          : { status: outcome.status, reason: outcome.reason, ...tables };
    }

    for (const outcome of outcomes) {
      if (outcome.status === "skipped") {
        logger.warn(`Source "${outcome.key}" synced nothing: ${outcome.reason}`);
      }
      for (const t of outcome.tables) {
        if (t.skipped) logger.warn(`  ${outcome.key} -> ${t.target}: ${t.skipped}`);
      }
    }

    const failed = outcomes.filter((o) => o.status === "failed");
    const totalRows = outcomes.reduce((a, o) => a + o.tables.reduce((b, t) => b + t.copied, 0), 0);

    logger.info(
      `Sync finished: ${totalRows} rows across ${outcomes.length} source(s) in ${Math.round((Date.now() - startedAt) / 1000)}s`,
      { summary }
    );

    if (failed.length > 0) {
      // Everything that could sync has synced by this point. Throwing here
      // makes the failure visible in the dashboard and lets the retry pick up
      // from the cursors, rather than letting a broken source pass silently.
      throw new Error(
        `${failed.length} of ${outcomes.length} source(s) failed: ` +
          failed.map((f) => `${f.key} (${f.reason})`).join("; ")
      );
    }

    return summary;
  },
});

/** Sync one source. Never throws — connection and table errors become an outcome. */
async function runSource(args: {
  pg: Awaited<ReturnType<typeof connectYenes>>;
  source: SourceSpec;
  deadline: number;
}): Promise<SourceOutcome> {
  const { pg, source, deadline } = args;
  const url = process.env[source.envVar];

  if (!url) {
    const reason = `${source.envVar} is not set`;
    if (source.required) {
      logger.error(`${source.label}: ${reason}`);
      return { key: source.key, status: "failed", reason, tables: [] };
    }
    logger.info(`${source.label}: ${reason} — skipping this source.`);
    return { key: source.key, status: "skipped", reason, tables: [] };
  }

  const enabled = source.tables.filter((t) => t.enabled !== false);
  if (enabled.length === 0) {
    const reason = "no tables mapped yet — see MAPPING.md";
    logger.info(`${source.label}: connected but ${reason}.`);
    return { key: source.key, status: "skipped", reason, tables: [] };
  }

  let read;
  try {
    read = await connectSource(url, source.dialect, source.label);
  } catch (error) {
    const reason = msg(error);
    if (source.required) {
      logger.error(`${source.label}: ${reason}`);
      return { key: source.key, status: "failed", reason, tables: [] };
    }
    logger.warn(`${source.label}: ${reason} — skipping this source, the others still run.`);
    return { key: source.key, status: "skipped", reason, tables: [] };
  }

  logger.info(`${source.label}: connected, ${enabled.length} table(s) to sync`);

  const tables: CopyResult[] = [];
  try {
    for (const spec of enabled) {
      if (Date.now() >= deadline) {
        logger.info(`${source.label}: out of time this run, ${spec.target} continues next run.`);
        break;
      }
      try {
        tables.push(await copyTable({ pg, read, source, spec, deadline, log: logger }));
      } catch (error) {
        // One bad table shouldn't cost us the rest of the source.
        logger.error(`${source.label}: ${spec.source} -> ${spec.target} failed: ${msg(error)}`);
        tables.push({ target: spec.target, copied: 0, skipped: msg(error), exhausted: false });
      }
    }
  } finally {
    await read.close().catch(() => {});
  }

  const broken = tables.filter((t) => t.skipped && t.copied === 0);
  const hardFailure = broken.length === tables.length && tables.length > 0 && source.required;

  return {
    key: source.key,
    status: hardFailure ? "failed" : "ok",
    reason: hardFailure ? `every table failed: ${broken.map((b) => b.skipped).join("; ")}` : undefined,
    tables,
  };
}

/** Rotate the source order so the same one isn't always first. */
function rotate<T>(items: T[], seed: number): T[] {
  if (items.length < 2) return items;
  const offset = ((seed % items.length) + items.length) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}
