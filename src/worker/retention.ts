/**
 * 原件的保留期（docs/format.md §2.2 file.keep）：邀请关闭、作废或过期后 retainDays 天，删掉它在 R2 里的原件。
 * 产物（缩图、文字）不删。每天由 scheduled 触发一次；删过的记 originals_purged_at，之后 fetch 原件会说明已删。
 */
import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { nowSeconds } from "./clock.ts";
import { Db, num, str } from "./db.ts";

export const purgeOriginals = Effect.gen(function* () {
  const db = yield* Db;
  const now = yield* nowSeconds;
  const due = yield* db.all(
    `SELECT id, snapshot FROM invites
      WHERE originals_purged_at IS NULL
        AND COALESCE(closed_at, expires_at) + 86400 * CAST(json_extract(snapshot, '$.retainDays') AS INTEGER) <= ?`,
    [now],
  );
  let deleted = 0;
  for (const row of due) {
    const id = str(row, "id");
    const keys = yield* db.all(
      `SELECT r2_prefix FROM products WHERE invite_id = ? AND op = 'file.keep' AND status = 'done' AND r2_prefix IS NOT NULL`,
      [id],
    );
    for (const k of keys) {
      const prefix = str(k, "r2_prefix");
      const listed = yield* Effect.promise(() => env.FILES.list({ prefix }));
      const originals = listed.objects
        .map((o) => o.key)
        .filter((key) => key.slice(prefix.length).startsWith("original"));
      if (originals.length) yield* Effect.promise(() => env.FILES.delete(originals));
      deleted += originals.length;
    }
    yield* db.run("UPDATE invites SET originals_purged_at = ? WHERE id = ?", [now, id]);
  }
  return { invites: due.length, deleted, at: num({ now }, "now") };
});
