/**
 * 费用账本（docs/format.md §3.4）：calls 表既是流水也是余额——已花 = settled 的 used，已预留 = reserved 的 est。
 * 预留是**一条**带条件的 INSERT：没有上限，或 已花 + 已预留 + 这次估价 ≤ 上限，才插得进去。D1 逐条串行执行写入，
 * 所以并发的预留不可能一起越过上限。调用结束按实际用量结算；调用失败就释放。
 */
import { Effect } from "effect";
import { nowSeconds } from "./clock.ts";
import { Db, num } from "./db.ts";
import type { ModelUse } from "../shared/budget.ts";

export type Reservation = { readonly id: number; readonly estimate: number };

/** 预留一次调用。上限不够时记一条 refused（计入「因上限跳过」），返回 null。 */
export const reserve = (
  inviteId: string,
  round: number,
  use: ModelUse,
  model: string,
  estimate: number,
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const at = yield* nowSeconds;
    const row = yield* db.first(
      `INSERT INTO calls (invite_id, round, use, model, est_nano, status, at)
       SELECT ?1, ?2, ?3, ?4, ?5, 'reserved', ?6
       WHERE (SELECT budget_nano FROM invites WHERE id = ?1) IS NULL
          OR (SELECT COALESCE(SUM(CASE status WHEN 'reserved' THEN est_nano WHEN 'settled' THEN used_nano ELSE 0 END), 0)
                FROM calls WHERE invite_id = ?1) + ?5 <= (SELECT budget_nano FROM invites WHERE id = ?1)
       RETURNING id`,
      [inviteId, round, use, model, estimate, at],
    );
    if (row) return { id: num(row, "id"), estimate } satisfies Reservation;
    yield* db.run(
      "INSERT INTO calls (invite_id, round, use, model, est_nano, used_nano, status, at) VALUES (?, ?, ?, ?, ?, 0, 'refused', ?)",
      [inviteId, round, use, model, estimate, at],
    );
    return null;
  });

/** 按实际用量结算（不超过估价：估价是上界，模型多报也只按预留的算，账不会越过上限）。 */
export const settle = (r: Reservation, used: number) =>
  Effect.flatMap(Db, (db) =>
    db.run(
      "UPDATE calls SET status = 'settled', used_nano = ? WHERE id = ? AND status = 'reserved'",
      [Math.max(0, Math.min(Math.round(used), r.estimate)), r.id],
    ),
  );

/** 调用失败：释放预留。 */
export const release = (r: Reservation) =>
  Effect.flatMap(Db, (db) =>
    db.run(
      "UPDATE calls SET status = 'released', used_nano = 0 WHERE id = ? AND status = 'reserved'",
      [r.id],
    ),
  );

export type Money = { readonly spentNano: number; readonly reservedNano: number };
export const money = (inviteId: string) =>
  Effect.gen(function* () {
    const row = yield* (yield* Db).first(
      `SELECT COALESCE(SUM(CASE WHEN status = 'settled' THEN used_nano ELSE 0 END), 0) AS spent,
              COALESCE(SUM(CASE WHEN status = 'reserved' THEN est_nano ELSE 0 END), 0) AS reserved
         FROM calls WHERE invite_id = ?`,
      [inviteId],
    );
    return {
      spentNano: num(row ?? {}, "spent"),
      reservedNano: num(row ?? {}, "reserved"),
    } satisfies Money;
  });

/** 一轮的用量（manifest 的 usage）。 */
export const roundUsage = (inviteId: string, round: number) =>
  Effect.gen(function* () {
    const rows = yield* (yield* Db).all(
      `SELECT use, status, COUNT(*) AS n, COALESCE(SUM(used_nano), 0) AS used FROM calls
        WHERE invite_id = ? AND round = ? GROUP BY use, status`,
      [inviteId, round],
    );
    const calls = { sort: 0, describe: 0, transcribe: 0 };
    let used = 0;
    let budget = 0;
    for (const r of rows) {
      const use = r["use"] as keyof typeof calls;
      if (r["status"] === "settled") {
        calls[use] += num(r, "n");
        used += num(r, "used");
      }
      if (r["status"] === "refused") budget += num(r, "n");
    }
    return { usd: Math.round(used) / 1e9, calls, skipped: { budget } };
  });
