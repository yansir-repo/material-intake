/**
 * D1 里的事实：邀请、轮次、文件、产物、声明。每个读出来的行都在这里解成 shared 的类型，别处不碰原始行。
 */
import { Data, Effect } from "effect";
import { nowSeconds } from "./clock.ts";
import { Db, num, optStr, str, type Row } from "./db.ts";
import type { AcceptKind } from "../shared/kinds.ts";
import type { FileRecord, Product, ProductStatus } from "../shared/model.ts";
import { isOpName, type Params } from "../shared/ops.ts";
import type { Assignment } from "../shared/sort.ts";
import type { Snapshot } from "../shared/template.ts";
import { sha256Hex } from "../shared/sha256.ts";

export class NotFound extends Data.TaggedError("NotFound")<{ readonly what: string }> {}
export class Refused extends Data.TaggedError("Refused")<{ readonly message: string }> {}

const json = <T>(text: string | null, fallback: T): T => {
  if (text === null || text === "") return fallback;
  return JSON.parse(text) as T;
};

// ---- 邀请 ----------------------------------------------------------------------------------------

export type InviteStatus = "open" | "closed" | "revoked";
export type Invite = {
  readonly id: string;
  readonly keyHash: string;
  readonly ref: string;
  readonly snapshot: Snapshot;
  readonly budgetNano: number | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly status: InviteStatus;
  readonly closedAt: number | null;
  readonly originalsPurgedAt: number | null;
};

const inviteOf = (r: Row): Invite => ({
  id: str(r, "id"),
  keyHash: str(r, "key_hash"),
  ref: str(r, "ref"),
  snapshot: json<Snapshot>(optStr(r, "snapshot"), undefined as unknown as Snapshot),
  budgetNano:
    r["budget_nano"] === null || r["budget_nano"] === undefined ? null : num(r, "budget_nano"),
  createdAt: num(r, "created_at"),
  expiresAt: num(r, "expires_at"),
  status: str(r, "status") as InviteStatus,
  closedAt: r["closed_at"] === null || r["closed_at"] === undefined ? null : num(r, "closed_at"),
  originalsPurgedAt:
    r["originals_purged_at"] === null || r["originals_purged_at"] === undefined
      ? null
      : num(r, "originals_purged_at"),
});

/** 现在还收不收：状态 open 且没过期。 */
export const openness = (inv: Invite, now: number): "" | "closed" | "expired" | "revoked" =>
  inv.status === "revoked"
    ? "revoked"
    : inv.status === "closed"
      ? "closed"
      : now >= inv.expiresAt
        ? "expired"
        : "";

export const findInvite = (id: string) =>
  Effect.gen(function* () {
    const row = yield* (yield* Db).first("SELECT * FROM invites WHERE id = ?", [id]);
    return row ? inviteOf(row) : null;
  });

export const getInvite = (id: string) =>
  Effect.flatMap(findInvite(id), (inv) =>
    inv ? Effect.succeed(inv) : Effect.fail(new NotFound({ what: id })),
  );

export const listInvites = Effect.gen(function* () {
  return (yield* (yield* Db).all("SELECT * FROM invites ORDER BY created_at DESC LIMIT 500")).map(
    inviteOf,
  );
});

// ---- 门：/i/<id>.<key> ----------------------------------------------------------------------------

export const INVITE_ID_RE = /^inv_[a-z0-9]{10}$/;
export const KEY_RE = /^[0-9a-f]{24}$/;

const randomHex = (bytes: number) =>
  Effect.sync(() =>
    [...crypto.getRandomValues(new Uint8Array(bytes))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
  );
const ALPHA = "abcdefghijkmnpqrstuvwxyz23456789";
const randomAlpha = (n: number) =>
  Effect.sync(() =>
    [...crypto.getRandomValues(new Uint8Array(n))].map((b) => ALPHA[b % ALPHA.length]).join(""),
  );

export const newInviteId = Effect.map(randomAlpha(10), (s) => `inv_${s}`);
export const newKey = randomHex(12);
export const newFileId = Effect.map(randomAlpha(10), (s) => `f_${s}`);
export const hashKey = (key: string): string => sha256Hex(`material-intake:${key}`);

/** 常量时间比较：key 不靠比较耗时泄露。 */
export const sameSecret = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export const parseInvitePath = (
  pathname: string,
): { id: string; key: string; rest: string } | null => {
  const m = /^\/i\/(inv_[a-z0-9]{10})\.([0-9a-f]{24})(\/.*)?$/.exec(pathname);
  return m ? { id: m[1]!, key: m[2]!, rest: m[3] ?? "/" } : null;
};
export const invitePath = (id: string, key: string): string => `/i/${id}.${key}`;

/** 对方这一侧的门：id + key 都对才算；错一律同一种结果，不泄露哪个 id 存在。 */
export const openInvite = (id: string, key: string) =>
  Effect.map(findInvite(id), (inv) =>
    inv !== null && sameSecret(inv.keyHash, hashKey(key)) ? inv : null,
  );

// ---- 轮次 ----------------------------------------------------------------------------------------

/** 草稿轮：没提交的那一轮；没有就开一轮（编号接着上一轮）。 */
export const draftRound = (inviteId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const open = yield* db.first(
      "SELECT n FROM rounds WHERE invite_id = ? AND submitted_at IS NULL",
      [inviteId],
    );
    if (open) return num(open, "n");
    const last = yield* db.first(
      "SELECT COALESCE(MAX(n), 0) AS n FROM rounds WHERE invite_id = ?",
      [inviteId],
    );
    const n = num(last ?? {}, "n") + 1;
    yield* db.run("INSERT OR IGNORE INTO rounds (invite_id, n, created_at) VALUES (?, ?, ?)", [
      inviteId,
      n,
      yield* nowSeconds,
    ]);
    return n;
  });

/** 当前轮次号（不开新轮）：草稿轮，或者最后一轮 + 1。 */
export const currentRound = (inviteId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const open = yield* db.first(
      "SELECT n FROM rounds WHERE invite_id = ? AND submitted_at IS NULL",
      [inviteId],
    );
    if (open) return num(open, "n");
    const last = yield* db.first(
      "SELECT COALESCE(MAX(n), 0) AS n FROM rounds WHERE invite_id = ?",
      [inviteId],
    );
    return num(last ?? {}, "n") + 1;
  });

export type SubmittedRound = {
  readonly n: number;
  readonly submittedAt: number;
  readonly manifest: string;
};
export const submittedRounds = (inviteId: string) =>
  Effect.gen(function* () {
    const rows = yield* (yield* Db).all(
      "SELECT n, submitted_at, manifest FROM rounds WHERE invite_id = ? AND submitted_at IS NOT NULL ORDER BY n",
      [inviteId],
    );
    return rows.map((r): SubmittedRound => ({
      n: num(r, "n"),
      submittedAt: num(r, "submitted_at"),
      manifest: str(r, "manifest"),
    }));
  });

// ---- 文件 ----------------------------------------------------------------------------------------

const fileOf = (r: Row): FileRecord => ({
  id: str(r, "id"),
  round: num(r, "round"),
  name: str(r, "name"),
  path: str(r, "path"),
  kind: str(r, "kind") as AcceptKind,
  mime: str(r, "mime"),
  bytes: num(r, "bytes"),
  sha256: str(r, "sha256"),
  facts: json(optStr(r, "facts"), {}),
  assignment: json<Assignment | null>(optStr(r, "assignment"), null),
  failure: json<FileRecord["failure"]>(optStr(r, "failure"), null),
  duplicateOf: optStr(r, "duplicate_of"),
});

/** 一轮的文件（带「同一邀请里第一次出现的同一份内容」）。 */
export const roundFiles = (inviteId: string, round: number) =>
  Effect.gen(function* () {
    const rows = yield* (yield* Db).all(
      `SELECT f.*, (SELECT g.id FROM files g WHERE g.invite_id = f.invite_id AND g.sha256 = f.sha256 AND g.created_at < f.created_at
                    ORDER BY g.created_at LIMIT 1) AS duplicate_of
         FROM files f WHERE f.invite_id = ? AND f.round = ? ORDER BY f.created_at, f.path`,
      [inviteId, round],
    );
    return rows.map(fileOf);
  });

export const getFile = (inviteId: string, fileId: string) =>
  Effect.gen(function* () {
    const row = yield* (yield* Db).first(
      "SELECT *, NULL AS duplicate_of FROM files WHERE invite_id = ? AND id = ?",
      [inviteId, fileId],
    );
    return row ? fileOf(row) : yield* Effect.fail(new NotFound({ what: fileId }));
  });

export const setAssignment = (fileId: string, a: Assignment) =>
  Effect.flatMap(Db, (db) =>
    db.run("UPDATE files SET assignment = ? WHERE id = ?", [JSON.stringify(a), fileId]),
  );

export const setFailure = (fileId: string, failure: FileRecord["failure"]) =>
  Effect.flatMap(Db, (db) =>
    db.run("UPDATE files SET failure = ? WHERE id = ?", [
      failure ? JSON.stringify(failure) : null,
      fileId,
    ]),
  );

// ---- 产物 ----------------------------------------------------------------------------------------

const productOf = (r: Row): Product | null => {
  const op = str(r, "op");
  if (!isOpName(op)) return null;
  return {
    op,
    params: json<Params>(optStr(r, "params"), {}),
    stepId: str(r, "step_id"),
    status: str(r, "status") as ProductStatus,
    ...(optStr(r, "reason") ? { reason: str(r, "reason") } : {}),
    meta: json(optStr(r, "meta"), {}),
    ...(r["text"] !== null && r["text"] !== undefined ? { text: str(r, "text") } : {}),
    ...(optStr(r, "lost") ? { lost: str(r, "lost") } : {}),
    ...(optStr(r, "model") ? { model: str(r, "model") } : {}),
    ...(optStr(r, "reads") ? { reads: json<ReadonlyArray<string>>(optStr(r, "reads"), []) } : {}),
    ...(optStr(r, "segments")
      ? { segments: json<Product["segments"]>(optStr(r, "segments"), []) }
      : {}),
  };
};

/** 一份内容在这个邀请里已有的产物，按步骤 id。 */
export const productsOf = (inviteId: string, sha256: string) =>
  Effect.gen(function* () {
    const rows = yield* (yield* Db).all(
      "SELECT * FROM products WHERE invite_id = ? AND sha256 = ?",
      [inviteId, sha256],
    );
    const map = new Map<string, Product>();
    for (const r of rows) {
      const p = productOf(r);
      if (p) map.set(p.stepId, p);
    }
    return map as ReadonlyMap<string, Product>;
  });

export const r2PrefixOf = (inviteId: string, sha256: string, stepId: string): string =>
  `inv/${inviteId}/p/${sha256}/${stepId}/`;

export type ProductWrite = {
  readonly inviteId: string;
  readonly sha256: string;
  readonly stepId: string;
  readonly op: string;
  readonly params: Params;
  readonly status: ProductStatus;
  readonly reason?: string;
  readonly meta?: unknown;
  readonly text?: string;
  readonly lost?: string;
  readonly model?: string;
  readonly reads?: ReadonlyArray<string>;
  readonly segments?: unknown;
  readonly r2Prefix?: string;
};

/** 写一个产物。已经 done 的不覆盖（同一份内容在同一邀请里只算一次）；partial 可以被续写或完成。 */
export const putProduct = (w: ProductWrite) =>
  Effect.gen(function* () {
    const now = yield* nowSeconds;
    return yield* (yield* Db).run(
      `INSERT INTO products (invite_id, sha256, step_id, op, params, status, reason, meta, text, lost, model, reads, segments, r2_prefix, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (invite_id, sha256, step_id) DO UPDATE SET
         status = excluded.status, reason = excluded.reason, meta = excluded.meta, text = excluded.text, lost = excluded.lost,
         model = excluded.model, reads = excluded.reads, segments = excluded.segments, r2_prefix = excluded.r2_prefix
       WHERE products.status <> 'done'`,
      [
        w.inviteId,
        w.sha256,
        w.stepId,
        w.op,
        JSON.stringify(w.params),
        w.status,
        w.reason ?? null,
        JSON.stringify(w.meta ?? {}),
        w.text ?? null,
        w.lost ?? null,
        w.model ?? null,
        w.reads ? JSON.stringify(w.reads) : null,
        w.segments ? JSON.stringify(w.segments) : null,
        w.r2Prefix ?? null,
        now,
      ],
    );
  });

// ---- 声明 ----------------------------------------------------------------------------------------

export const roundNotes = (inviteId: string, round: number) =>
  Effect.gen(function* () {
    const rows = yield* (yield* Db).all(
      "SELECT item, none, note FROM notes WHERE invite_id = ? AND round = ?",
      [inviteId, round],
    );
    const out: Record<string, { none: boolean; note: string }> = {};
    for (const r of rows)
      out[str(r, "item")] = { none: num(r, "none") === 1, note: str(r, "note") };
    return out as Readonly<Record<string, { readonly none: boolean; readonly note: string }>>;
  });

export const putNote = (
  inviteId: string,
  round: number,
  item: string,
  none: boolean,
  note: string,
) =>
  Effect.flatMap(Db, (db) =>
    db.run(
      `INSERT INTO notes (invite_id, round, item, none, note) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (invite_id, round, item) DO UPDATE SET none = excluded.none, note = excluded.note`,
      [inviteId, round, item, none ? 1 : 0, note],
    ),
  );
