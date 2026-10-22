/**
 * agent 的每个动作（清单在 shared/tools.ts）。运营接口 POST /admin/act/<名字> 和 MCP 的 tools/call 都调 `act`。
 */
import { isoOf } from "../shared/time.ts";
import { env } from "cloudflare:workers";
import { Clock, Data, Duration, Effect } from "effect";
import formatGuide from "../../docs/format.md?raw";
import { TEMPLATES } from "../../templates/index.ts";
import { nowSeconds } from "./clock.ts";
import { Db, num } from "./db.ts";
import { money } from "./ledger.ts";
import {
  currentRound,
  findInvite,
  getInvite,
  hashKey,
  invitePath,
  listInvites,
  newInviteId,
  newKey,
  openness,
  r2PrefixOf,
  roundFiles,
  submittedRounds,
  type Invite,
} from "./store.ts";
import { toNano, toUsd } from "../shared/budget.ts";
import { renderMap, type Manifest } from "../shared/manifest.ts";
import { OPS } from "../shared/ops.ts";
import { resolve, type Overrides } from "../shared/template.ts";

export class BadArgs extends Data.TaggedError("BadArgs")<{ readonly message: string }> {}
const bad = (message: string) => Effect.fail(new BadArgs({ message }));

type Args = Readonly<Record<string, unknown>>;
const field = (args: Args, name: string) =>
  typeof args[name] === "string" && (args[name] as string).trim() !== ""
    ? Effect.succeed((args[name] as string).trim())
    : bad(`missing ${name}`);
const optInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) ? v : undefined;

const origin = () => env.PUBLIC_URL.replace(/\/$/, "");

const templateOf = (args: Args) =>
  Effect.gen(function* () {
    const id = yield* field(args, "template");
    const t = TEMPLATES[id];
    return (
      t ?? (yield* bad(`unknown template ${id} (templates: ${Object.keys(TEMPLATES).join(", ")})`))
    );
  });

/** 覆盖的形状只粗查（是不是对象）；每个字段的类型和范围由 resolve 逐条核对、逐条报。 */
const overridesOf = (args: Args): Effect.Effect<Overrides, BadArgs> => {
  const o = args["overrides"];
  if (o === undefined || o === null) return Effect.succeed({});
  if (typeof o !== "object" || Array.isArray(o)) return bad("overrides must be an object");
  const x = o as Record<string, unknown>;
  if (x["items"] !== undefined && !Array.isArray(x["items"]))
    return bad("overrides.items must be a list");
  for (const k of ["pipeline", "sort"])
    if (x[k] !== undefined && (typeof x[k] !== "object" || Array.isArray(x[k])))
      return bad(`overrides.${k} must be an object`);
  return Effect.succeed(x as Overrides);
};

const summary = (inv: Invite, now: number) => ({
  id: inv.id,
  ref: inv.ref,
  title: inv.snapshot.title,
  template: inv.snapshot.template,
  status: openness(inv, now) || "open",
  createdAt: isoOf(inv.createdAt),
  expiresAt: isoOf(inv.expiresAt),
});

const manifestOf = (inv: Invite, round: number | undefined) =>
  Effect.gen(function* () {
    const rounds = yield* submittedRounds(inv.id);
    if (rounds.length === 0) return yield* bad("no round has been submitted yet");
    const r = round === undefined ? rounds.at(-1)! : rounds.find((x) => x.n === round);
    if (!r)
      return yield* bad(
        `round ${round} has not been submitted (submitted: ${rounds.map((x) => x.n).join(", ")})`,
      );
    return JSON.parse(r.manifest) as Manifest;
  });

/** 产物路径 files/<文件>/<步骤>/<名字> → 内容。文字在 D1，图片和原件在 R2。 */
const fetchArtifact = (inv: Invite, round: number, path: string) =>
  Effect.gen(function* () {
    const m = /^files\/(f_[a-z0-9]{10})\/([a-z.]+\.[0-9a-f]{8})\/([a-z0-9][a-z0-9._-]{0,60})$/.exec(
      path,
    );
    if (!m) return yield* bad("path must look like files/<fileId>/<stepId>/<name>");
    const [, fileId, stepId, name] = m as unknown as [string, string, string, string];
    const manifest = yield* manifestOf(inv, round);
    const file = manifest.files[fileId];
    if (!file) return yield* bad(`no file ${fileId} in round ${round}`);
    if (name === "text.md" || name === "transcript.md") {
      const row = yield* (yield* Db).first(
        "SELECT text FROM products WHERE invite_id = ? AND sha256 = ? AND step_id = ?",
        [inv.id, file.source.sha256, stepId],
      );
      if (!row || typeof row["text"] !== "string") return yield* bad("no such text artifact");
      return { kind: "text", text: row["text"] as string } satisfies ActResult;
    }
    if (name.startsWith("original") && inv.originalsPurgedAt !== null)
      return yield* bad(
        `originals were deleted on ${isoOf(inv.originalsPurgedAt)} (retainDays = ${inv.snapshot.retainDays})`,
      );
    const obj = yield* Effect.promise(() =>
      env.FILES.get(r2PrefixOf(inv.id, file.source.sha256, stepId) + name),
    );
    if (!obj) return yield* bad("no such artifact");
    const bytes = new Uint8Array(yield* Effect.promise(() => obj.arrayBuffer()));
    return {
      kind: "bytes",
      contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
      bytes,
    } satisfies ActResult;
  });

const statusOf = (inv: Invite) =>
  Effect.gen(function* () {
    const now = yield* nowSeconds;
    const round = yield* currentRound(inv.id);
    const files = yield* roundFiles(inv.id, round);
    const m = yield* money(inv.id);
    const rounds = yield* submittedRounds(inv.id);
    return {
      ...summary(inv, now),
      submitted: rounds.map((r) => ({ round: r.n, at: isoOf(r.submittedAt) })),
      draft: {
        round,
        files: files.length,
        perItem: Object.fromEntries(
          inv.snapshot.items.map((it) => [
            it.key,
            files.filter((f) => f.assignment?.item === it.key).length,
          ]),
        ),
        unassigned: files.filter((f) => f.assignment !== null && f.assignment.item === null).length,
        processing: files.filter((f) => f.assignment === null).length,
      },
      money: {
        spentUsd: toUsd(m.spentNano),
        reservedUsd: toUsd(m.reservedNano),
        capUsd: inv.budgetNano === null ? null : toUsd(inv.budgetNano),
      },
      originalsPurgedAt: inv.originalsPurgedAt === null ? null : isoOf(inv.originalsPurgedAt),
    };
  });

export type ActResult =
  | { readonly kind: "json"; readonly value: unknown }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "bytes"; readonly contentType: string; readonly bytes: Uint8Array };
const json = (value: unknown): ActResult => ({ kind: "json", value });

export const act = (name: string, args: Args) =>
  Effect.gen(function* () {
    const db = yield* Db;
    switch (name) {
      case "guide":
        return { kind: "text", text: formatGuide } satisfies ActResult;
      case "ops":
        return json(
          Object.values(OPS).map((o) => ({
            name: o.name,
            accepts: o.accepts,
            input: o.input,
            class: o.cls,
            params: o.params,
            describe: o.describe,
          })),
        );
      case "templates":
        return json(
          Object.values(TEMPLATES).map((t) => ({
            id: t.id,
            version: t.version,
            title: t.title,
            items: t.items.map((i) => i.key),
          })),
        );
      case "template":
        return json(yield* templateOf(args));
      case "validate": {
        const r = resolve(yield* templateOf(args), yield* overridesOf(args));
        return json(r.ok ? { ok: true, snapshot: r.snapshot } : r);
      }
      case "create": {
        const r = resolve(yield* templateOf(args), yield* overridesOf(args));
        if (!r.ok) return json(r);
        const ref = typeof args["ref"] === "string" ? args["ref"].slice(0, 100) : "";
        const id = yield* newInviteId;
        const key = yield* newKey;
        const now = yield* nowSeconds;
        yield* db.run(
          "INSERT INTO invites (id, key_hash, ref, snapshot, budget_nano, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [
            id,
            hashKey(key),
            ref,
            JSON.stringify(r.snapshot),
            r.snapshot.budget ? toNano(r.snapshot.budget.usd) : null,
            now,
            now + r.snapshot.expiresInDays * 86400,
          ],
        );
        return json({
          ok: true,
          id,
          url: `${origin()}${invitePath(id, key)}`,
          expiresAt: isoOf(now + r.snapshot.expiresInDays * 86400),
        });
      }
      case "list": {
        const now = yield* nowSeconds;
        const invites = yield* listInvites;
        const counts = yield* db.all(
          "SELECT invite_id, COUNT(*) AS n FROM rounds WHERE submitted_at IS NOT NULL GROUP BY invite_id",
        );
        const n = new Map(counts.map((r) => [String(r["invite_id"]), num(r, "n")]));
        return json(invites.map((inv) => ({ ...summary(inv, now), rounds: n.get(inv.id) ?? 0 })));
      }
      case "status":
        return json(yield* statusOf(yield* getInvite(yield* field(args, "id"))));
      case "wait": {
        const id = yield* field(args, "id");
        const after = optInt(args["after"]) ?? 0;
        const timeout = Math.min(25, Math.max(1, optInt(args["timeout"]) ?? 25));
        const until = (yield* Clock.currentTimeMillis) + timeout * 1000;
        for (;;) {
          const latest = (yield* submittedRounds(id)).at(-1)?.n ?? 0;
          if (latest > after) return json({ submitted: latest });
          if ((yield* Clock.currentTimeMillis) >= until) return json({ submitted: null });
          yield* Effect.sleep(Duration.seconds(2));
        }
      }
      case "result": {
        const inv = yield* getInvite(yield* field(args, "id"));
        const m = yield* manifestOf(inv, optInt(args["round"]));
        return args["format"] === "md"
          ? ({ kind: "text", text: renderMap(m) } satisfies ActResult)
          : json(m);
      }
      case "fetch": {
        const inv = yield* getInvite(yield* field(args, "id"));
        const round = optInt(args["round"]);
        if (round === undefined) return yield* bad("round must be an integer");
        return yield* fetchArtifact(inv, round, yield* field(args, "path"));
      }
      case "rotate": {
        const inv = yield* getInvite(yield* field(args, "id"));
        const key = yield* newKey;
        yield* db.run("UPDATE invites SET key_hash = ? WHERE id = ?", [hashKey(key), inv.id]);
        return json({ ok: true, id: inv.id, url: `${origin()}${invitePath(inv.id, key)}` });
      }
      case "close":
      case "revoke": {
        const inv = yield* getInvite(yield* field(args, "id"));
        const status = name === "close" ? "closed" : "revoked";
        yield* db.run(
          "UPDATE invites SET status = ?, closed_at = COALESCE(closed_at, ?) WHERE id = ?",
          [status, yield* nowSeconds, inv.id],
        );
        return json({ ok: true, id: inv.id, status });
      }
      case "budget": {
        const inv = yield* getInvite(yield* field(args, "id"));
        const usd = args["usd"];
        if (usd !== null && (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0))
          return yield* bad("usd must be a positive number or null");
        yield* db.run("UPDATE invites SET budget_nano = ? WHERE id = ?", [
          usd === null ? null : toNano(usd),
          inv.id,
        ]);
        return json(yield* statusOf((yield* findInvite(inv.id))!));
      }
    }
    return yield* bad(`unknown action ${name}`);
  });
