/**
 * The Worker. One deployment serves every invite: an invite is rows in D1 plus objects in R2.
 *
 *   GET  /i/<id>.<key>                         the respondent's page (only when id + key match)
 *        /i/<id>.<key>/api/*                   the page's actions (worker/intake.ts)
 *   POST /admin/act/<action>                   the agent's actions (Bearer ADMIN_TOKEN; shared/tools.ts, worker/admin.ts)
 *   POST /mcp                                  the same actions over MCP (Bearer)
 *   GET  /llms.txt                             the guide (docs/format.md), public: no credentials, no respondent data
 *   scheduled                                  daily: delete originals past retainDays (worker/retention.ts)
 */
import { env } from "cloudflare:workers";
import { Cause, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import formatGuide from "../../docs/format.md?raw";
import { act, BadArgs } from "./admin.ts";
import { DbLive, type D1Like } from "./db.ts";
import * as intake from "./intake.ts";
import { handleMcp } from "./mcp.ts";
import { purgeOriginals } from "./retention.ts";
import {
  NotFound,
  openInvite,
  parseInvitePath,
  Refused,
  sameSecret,
  type Invite,
} from "./store.ts";

const PRIVATE = { "cache-control": "private, no-store", "x-robots-tag": "noindex" } as const;
const json = (data: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(data, { status, headers: PRIVATE });
const NOT_FOUND = () => HttpServerResponse.text("没有这个页面", { status: 404, headers: PRIVATE });

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const readJson = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const text = yield* request.text;
    if (text.length > 500_000) return {};
    const v = yield* decodeJson(text).pipe(Effect.orElseSucceed(() => ({})));
    return (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {}) as Readonly<
      Record<string, unknown>
    >;
  });
const readBytes = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.map(request.arrayBuffer, (b) => new Uint8Array(b)).pipe(
    Effect.orElseSucceed(() => new Uint8Array(0)),
  );
const str = (x: unknown): string => (typeof x === "string" ? x : "");

/** 动作的失败 → 对方或 agent 读得懂的一句话。 */
const answer = <A, R>(
  program: Effect.Effect<A, Refused | NotFound | BadArgs, R>,
  ok: (a: A) => HttpServerResponse.HttpServerResponse,
) =>
  program.pipe(
    Effect.map(ok),
    Effect.catchTags({
      Refused: (e) => Effect.succeed(json({ ok: false, error: e.message }, 422)),
      NotFound: (e) => Effect.succeed(json({ ok: false, error: `没有找到 ${e.what}` }, 404)),
      BadArgs: (e) => Effect.succeed(json({ ok: false, error: e.message }, 400)),
    }),
  );

// ---- 对方那一侧：key 就是门 ----------------------------------------------------------------------------

const clientApi = (
  inv: Invite,
  rest: string,
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
) =>
  Effect.gen(function* () {
    const method = request.method;
    const q = (k: string) => url.searchParams.get(k) ?? "";
    const n = (k: string) => Number(url.searchParams.get(k) ?? "NaN");
    const ok = (x: unknown) =>
      json({ ok: true, ...(typeof x === "object" && x !== null ? { file: x } : {}) });

    if (rest === "/api/state" && method === "GET")
      return yield* answer(intake.view(inv), (v) => json(v));
    if (rest === "/api/files" && method === "POST") {
      const nf = intake.parseNewFile(yield* readJson(request));
      if (typeof nf === "string") return json({ ok: false, error: nf }, 400);
      return yield* answer(intake.addFile(inv, nf), ok);
    }
    if (rest === "/api/submit" && method === "POST")
      return yield* answer(intake.submit(inv), (r) => json(r, r.ok ? 200 : 422));
    const item = /^\/api\/items\/([a-z0-9-]{1,40})$/.exec(rest);
    if (item && method === "PUT") {
      const body = yield* readJson(request);
      return yield* answer(
        intake.note(inv, item[1]!, body["none"] === true, str(body["note"])),
        () => json({ ok: true }),
      );
    }

    const file = /^\/api\/files\/(f_[a-z0-9]{10})(\/.*)?$/.exec(rest);
    if (!file) return NOT_FOUND();
    const fid = file[1]!;
    const sub = file[2] ?? "";
    if (sub === "" && method === "DELETE")
      return yield* answer(intake.removeFile(inv, fid), () => json({ ok: true }));
    if (sub === "/assign" && method === "PUT")
      return yield* answer(intake.assign(inv, fid, str((yield* readJson(request))["item"])), ok);
    if (sub === "/failure" && method === "POST") {
      const body = yield* readJson(request);
      return yield* answer(
        intake.reportFailure(inv, fid, str(body["op"]), str(body["reason"])),
        ok,
      );
    }
    if (sub === "/sort" && method === "POST") {
      const clip = yield* readBytes(request);
      return yield* answer(
        intake.sortFile(inv, fid, clip.length ? clip : null, n("seconds") || 0),
        ok,
      );
    }
    if (sub === "/describe" && method === "POST")
      return yield* answer(intake.runDescribe(inv, fid), ok);

    const step = /^\/steps\/([a-z.]+\.[0-9a-f]{8})(\/.*)$/.exec(sub);
    if (!step) return NOT_FOUND();
    const sid = step[1]!;
    const action = step[2]!;
    if (action === "/product" && method === "POST") {
      const web = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);
      const form = yield* Effect.promise(() => web.formData()).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (form === null) return json({ ok: false, error: "上传的内容读不出来" }, 400);
      return yield* answer(intake.putBrowserProduct(inv, fid, sid, form), ok);
    }
    if (action === "/transit" && method === "POST")
      return yield* answer(intake.transit(inv, fid, sid, yield* readBytes(request)), ok);
    if (action === "/audio" && method === "POST")
      return yield* answer(
        intake.audioSegment(
          inv,
          fid,
          sid,
          {
            index: n("index"),
            last: q("last") === "1",
            start: n("start"),
            duration: n("duration"),
          },
          yield* readBytes(request),
        ),
        ok,
      );
    if (action === "/skip" && method === "POST")
      return yield* answer(
        intake.markSkipped(inv, fid, sid, str((yield* readJson(request))["reason"])),
        ok,
      );
    if (action === "/original/start" && method === "POST")
      return yield* answer(intake.originalStart(inv, fid, sid), (r) => json({ ok: true, ...r }));
    if (action === "/original/part" && method === "PUT") {
      const web = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);
      if (!web.body) return json({ ok: false, error: "没有内容" }, 400);
      return yield* answer(
        intake.originalPart(inv, fid, sid, q("upload"), n("part"), web.body),
        (r) => json({ ok: true, ...r }),
      );
    }
    if (action === "/original/complete" && method === "POST") {
      const body = yield* readJson(request);
      const parts = Array.isArray(body["parts"])
        ? (body["parts"] as unknown[]).flatMap((p) => {
            const o = (typeof p === "object" && p !== null ? p : {}) as Record<string, unknown>;
            return typeof o["partNumber"] === "number" && typeof o["etag"] === "string"
              ? [{ partNumber: o["partNumber"], etag: o["etag"] }]
              : [];
          })
        : [];
      return yield* answer(
        intake.originalComplete(inv, fid, sid, str(body["uploadId"]), parts),
        ok,
      );
    }
    const prev = /^\/([a-z0-9][a-z0-9._-]{0,60})$/.exec(action);
    if (prev && method === "GET") {
      const obj = yield* intake
        .preview(inv, fid, sid, prev[1]!)
        .pipe(Effect.orElseSucceed(() => null));
      if (!obj) return NOT_FOUND();
      const body = new Uint8Array(yield* Effect.promise(() => obj.arrayBuffer()));
      return HttpServerResponse.uint8Array(body, {
        contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
        headers: PRIVATE,
      });
    }
    return NOT_FOUND();
  });

const clientRoute = (db: D1Like) =>
  HttpRouter.add(
    "*",
    "/i/*",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, "http://x");
      const parts = parseInvitePath(url.pathname);
      if (!parts) return NOT_FOUND();
      const inv = yield* openInvite(parts.id, parts.key);
      if (inv === null) return NOT_FOUND();
      if ((parts.rest === "/" || parts.rest === "") && request.method === "GET") {
        const shell = yield* Effect.promise(() =>
          env.ASSETS.fetch(new Request(`http://${request.headers["host"] ?? "localhost"}/`)),
        );
        const html = yield* Effect.promise(() => shell.text());
        return HttpServerResponse.text(html, {
          contentType: "text/html; charset=utf-8",
          headers: PRIVATE,
        });
      }
      return yield* clientApi(inv, parts.rest, request, url);
    }).pipe(Effect.provide(DbLive(db))),
  );

// ---- agent 那一侧：Bearer 令牌 ----------------------------------------------------------------------

const adminAllowed = (request: HttpServerRequest.HttpServerRequest): boolean => {
  const token = env.ADMIN_TOKEN ?? "";
  const given = /^Bearer (.+)$/.exec(request.headers["authorization"] ?? "")?.[1] ?? "";
  return token.length >= 16 && token !== "none" && sameSecret(token, given);
};

const adminRoute = (db: D1Like) =>
  HttpRouter.add(
    "*",
    "/admin/*",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (!adminAllowed(request)) return HttpServerResponse.text("需要令牌", { status: 401 });
      const m = /^\/admin\/act\/([a-z]+)$/.exec(new URL(request.url, "http://x").pathname);
      if (!m || request.method !== "POST") return NOT_FOUND();
      const args = yield* readJson(request);
      return yield* answer(act(m[1]!, args), (r) =>
        r.kind === "json"
          ? json(r.value)
          : r.kind === "text"
            ? HttpServerResponse.text(r.text, {
                contentType: "text/markdown; charset=utf-8",
                headers: PRIVATE,
              })
            : HttpServerResponse.uint8Array(r.bytes, {
                contentType: r.contentType,
                headers: PRIVATE,
              }),
      );
    }).pipe(Effect.provide(DbLive(db))),
  );

const mcpRoute = (db: D1Like) =>
  HttpRouter.add(
    "*",
    "/mcp",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (!adminAllowed(request)) return HttpServerResponse.text("需要令牌", { status: 401 });
      if (request.method !== "POST") return HttpServerResponse.empty({ status: 405 });
      const text = yield* request.text;
      const message = yield* decodeJson(text).pipe(Effect.orElseSucceed(() => null));
      if (message === null || typeof message !== "object")
        return json(
          { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
          400,
        );
      const reply = yield* handleMcp(message as Record<string, unknown>);
      return reply === null ? HttpServerResponse.empty({ status: 202 }) : json(reply);
    }).pipe(Effect.provide(DbLive(db))),
  );

/** One web handler per request: a Workers isolate serves requests concurrently, and I/O created for one request cannot be awaited by another. */
const buildHandler = (db: D1Like) =>
  HttpRouter.toWebHandler(Layer.mergeAll(clientRoute(db), adminRoute(db), mcpRoute(db)), {
    disableLogger: true,
    middleware: (app) =>
      app.pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            console.error("route defect:", Cause.pretty(cause).slice(0, 1500)),
          ).pipe(Effect.as(json({ ok: false, error: "服务出了点问题，请稍后重试" }, 500))),
        ),
      ),
  });

const HOME = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>资料收集</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3eee4;color:#1e1c18;font:16px/1.7 -apple-system,"PingFang SC",sans-serif;text-align:center;padding:24px}h1{font-size:24px;margin:0 0 8px}p{color:#8f887c;margin:0}</style></head>
<body><main><h1>资料收集</h1><p>请从发给你的专属链接进入。</p></main></body></html>`;

const GUIDE_HEAD = (origin: string) => `# material-intake

Agent actions: POST ${origin}/admin/act/<action> with a JSON body (Authorization: Bearer <ADMIN_TOKEN>), or MCP at ${origin}/mcp.
Actions: guide, ops, templates, template, validate, create, list, status, wait, result, fetch, rotate, close, revoke, budget.

---

`;

export default {
  fetch(request) {
    const { pathname, origin } = new URL(request.url);
    if (pathname === "/" && request.method === "GET")
      return Promise.resolve(
        new Response(HOME, {
          headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" },
        }),
      );
    if (pathname === "/llms.txt" && request.method === "GET")
      return Promise.resolve(
        new Response(GUIDE_HEAD(origin) + formatGuide, {
          headers: { "content-type": "text/markdown; charset=utf-8", "x-robots-tag": "noindex" },
        }),
      );
    if (!pathname.startsWith("/i/") && !pathname.startsWith("/admin/") && pathname !== "/mcp")
      return Promise.resolve(new Response("Not found", { status: 404 }));
    const web = buildHandler(env.DB);
    // Read the body out before disposing: the response streams from the runtime being disposed.
    return web.handler(request).then((response) =>
      response.arrayBuffer().then((body) => {
        void web.dispose();
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }),
    );
  },
  scheduled(_controller, _env, ctx) {
    ctx.waitUntil(runRetention());
  },
} satisfies ExportedHandler<Cloudflare.Env>;

/** The daily retention run: one Effect program per trigger. */
export const runRetention = (): Promise<void> =>
  Effect.runPromise(
    purgeOriginals.pipe(
      Effect.tap((r) => Effect.sync(() => console.log("retention:", JSON.stringify(r)))),
      Effect.asVoid,
      Effect.provide(DbLive(env.DB)),
    ),
  );
