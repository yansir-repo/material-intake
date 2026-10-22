/**
 * 部署后的冒烟测试：扮演对方的页面，对线上 Worker 走一轮完整流程——建邀请 → 放文件 → 产物 → 服务器转换 →
 * 归类（clef-flash 看图、clef-omni 听录音）→ 描述 → 转写 → 原件分片上传 → 提交 → 取 MAP.md / 转写稿 → 作废邀请。
 * 浏览器端的步骤（缩图）在本机用 ffmpeg 做；页面本身的代码在本地 dev 里验。会花一点模型费用（约 $0.01），所以不在门禁里。
 *
 *   node scripts/smoke.ts [--base https://…] [--dir testdata/公司资料]
 *
 * 令牌与地址同 scripts/do.ts（INTAKE_ADMIN_TOKEN / data/prod-secrets.json；INTAKE_BASE）。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { sniff } from "../src/shared/kinds.ts";
import type { PageFile } from "../src/shared/page.ts";

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i < 0 ? undefined : argv[i + 1];
};
const base = (
  flag("base") ??
  process.env["INTAKE_BASE"] ??
  "https://material-intake.yansir.workers.dev"
).replace(/\/$/, "");
const dir = flag("dir") ?? "testdata/公司资料";
const token =
  process.env["INTAKE_ADMIN_TOKEN"] ??
  (existsSync("data/prod-secrets.json")
    ? (JSON.parse(readFileSync("data/prod-secrets.json", "utf8")) as { ADMIN_TOKEN: string })
        .ADMIN_TOKEN
    : "") ??
  "";

const FILES = [
  "产品/A款/IMG_2041.jpg",
  "公司简介.docx",
  "产品参数表.csv",
  "采访录音.m4a",
  "logo.png",
];

const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) process.exitCode = 1;
};
const admin = async (action: string, args: object) => {
  const r = await fetch(`${base}/admin/act/${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`${action}: ${r.status} ${await r.text()}`);
  return r.headers.get("content-type")?.startsWith("application/json")
    ? ((await r.json()) as Record<string, unknown>)
    : { text: await r.text() };
};
let page = "";
const api = async (
  method: string,
  path: string,
  body?: BodyInit | object,
): Promise<{ ok?: boolean; error?: string; file?: PageFile } & Record<string, unknown>> => {
  const raw = body instanceof Uint8Array || body instanceof FormData || body instanceof Blob;
  const r = await fetch(`${page}${path}`, {
    method,
    headers: body !== undefined && !raw ? { "content-type": "application/json" } : {},
    body: body === undefined ? undefined : raw ? (body as BodyInit) : JSON.stringify(body),
  });
  const data = (await r.json()) as { ok?: boolean; error?: string; file?: PageFile };
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${data.error ?? ""}`);
  return data;
};
const ffmpeg = (args: string[]) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...args]);
const probe = (file: string, entries: string) =>
  execFileSync("ffprobe", ["-v", "error", "-show_entries", entries, "-of", "csv=p=0", file], {
    encoding: "utf8",
  }).trim();

/** 浏览器端的一步，在本机做出来（只覆盖冒烟要用的那几种）。 */
const browserStep = async (
  f: PageFile,
  local: string,
  op: string,
  params: Record<string, unknown>,
  stepId: string,
) => {
  if (op !== "image.resize") throw new Error(`smoke does not do ${op}`);
  const fmt = String(params["format"]);
  const out = `/tmp/smoke-${f.id}.${fmt === "jpeg" ? "jpg" : fmt}`;
  const edge = Number(params["longEdge"]);
  ffmpeg([
    "-i",
    local,
    "-vf",
    `scale='if(gt(iw,ih),min(${edge},iw),-2)':'if(gt(iw,ih),-2,min(${edge},ih))'`,
    ...(fmt === "webp" ? ["-quality", "82"] : []),
    out,
  ]);
  const [w, h] = probe(out, "stream=width,height").split(",").map(Number);
  const form = new FormData();
  form.set("meta", JSON.stringify({ width: w, height: h, format: fmt, mime: `image/${fmt}` }));
  form.append(
    "file",
    new File([readFileSync(out)], `image.${fmt === "jpeg" ? "jpg" : fmt}`, {
      type: `image/${fmt}`,
    }),
  );
  return (await api("POST", `/api/files/${f.id}/steps/${stepId}/product`, form)).file!;
};

const main = async () => {
  if (!token) throw new Error("no ADMIN_TOKEN");
  const inv = (await admin("create", {
    template: "website-kickoff",
    ref: "SMOKE",
    overrides: { budget: { usd: 0.2 } },
  })) as { id: string; url: string };
  page = inv.url;
  console.log(`invite ${inv.id}`);
  check((await fetch(`${page}/`)).status === 200, "the page opens with its key");
  check(
    (await fetch(`${base}/i/${inv.id}.${"0".repeat(24)}/api/state`)).status === 404,
    "a wrong key is a 404",
  );

  for (const rel of FILES) {
    const local = join(dir, rel);
    const bytes = readFileSync(local);
    const s = sniff(rel, new Uint8Array(bytes.subarray(0, 4096)));
    if (!s.ok) throw new Error(`${rel}: ${s.reason}`);
    const facts: Record<string, number> = {};
    if (s.kind === "image") {
      const [w, h] = probe(local, "stream=width,height").split(",").map(Number);
      Object.assign(facts, { width: w, height: h });
    }
    if (s.kind === "audio")
      facts["duration"] = Math.round(Number(probe(local, "format=duration")) * 10) / 10;
    let f = (
      await api("POST", "/api/files", {
        name: basename(rel),
        path: `公司资料/${rel}`,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        kind: s.kind,
        mime: s.mime,
        facts,
      })
    ).file!;
    for (const st of f.steps.filter((x) => x.status === "missing" && x.input === "browser"))
      f = await browserStep(f, local, st.op, st.params, st.stepId);
    for (const st of f.steps.filter((x) => x.status === "missing" && x.input === "transit"))
      f = (
        await api("POST", `/api/files/${f.id}/steps/${st.stepId}/transit`, new Uint8Array(bytes))
      ).file!;
    let clip: Uint8Array | undefined;
    if (s.kind === "audio") {
      ffmpeg(["-i", local, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "/tmp/smoke.wav"]);
      clip = new Uint8Array(readFileSync("/tmp/smoke.wav"));
    }
    f = (await api("POST", `/api/files/${f.id}/sort?seconds=${facts["duration"] ?? 0}`, clip))
      .file!;
    for (const st of f.steps.filter((x) => x.status === "missing" && x.input === "browser"))
      f = await browserStep(f, local, st.op, st.params, st.stepId);
    const tr = f.steps.find((x) => x.input === "audio" && x.status === "missing");
    if (tr && clip)
      f = (
        await api(
          "POST",
          `/api/files/${f.id}/steps/${tr.stepId}/audio?index=0&last=1&start=0&duration=${facts["duration"]}`,
          clip,
        )
      ).file!;
    if (f.steps.some((x) => x.input === "products" && x.status === "missing"))
      f = (await api("POST", `/api/files/${f.id}/describe`)).file!;
    const keep = f.steps.find((x) => x.op === "file.keep" && x.status !== "done");
    if (keep) {
      const start = await api("POST", `/api/files/${f.id}/steps/${keep.stepId}/original/start`);
      const part = await api(
        "PUT",
        `/api/files/${f.id}/steps/${keep.stepId}/original/part?upload=${encodeURIComponent(String(start["uploadId"]))}&part=1`,
        new Uint8Array(bytes),
      );
      f = (
        await api("POST", `/api/files/${f.id}/steps/${keep.stepId}/original/complete`, {
          uploadId: start["uploadId"],
          parts: [{ partNumber: part["partNumber"], etag: part["etag"] }],
        })
      ).file!;
    }
    const a = f.assignment;
    console.log(
      `  ${relative(".", local)} → ${a?.item ?? "未分类"} (${a?.by}${a && "p" in a && a.p !== undefined ? ` ${a.p}` : ""}) · ${f.state} · ${f.steps.map((x) => `${x.op}:${x.status}`).join(" ")}`,
    );
    check(f.state === "ready", `${rel} is ready`);
  }

  const submitted = await api("POST", "/api/submit");
  check(submitted["ok"] === true, "the round is submitted");
  const map = String((await admin("result", { id: inv.id, format: "md" }))["text"]);
  check(
    map.includes("模型转写") && map.includes("模型描述") && map.includes("原件，无损"),
    "MAP.md has a transcript, a description and an original",
  );
  const m = (await admin("result", { id: inv.id })) as {
    files: Record<string, { artifacts: Array<{ op: string; path?: string; text?: string }> }>;
  };
  const transcript = Object.values(m.files)
    .flatMap((f) => f.artifacts)
    .find((a) => a.op === "transcribe");
  check(
    (transcript?.text ?? "").length > 20,
    `transcript: ${(transcript?.text ?? "").slice(0, 40)}…`,
  );
  const status = (await admin("status", { id: inv.id })) as { money: { spentUsd: number } };
  console.log(`  spent $${status.money.spentUsd.toFixed(5)}`);
  await admin("revoke", { id: inv.id });
  check(
    (await fetch(`${page}/api/state`)).status === 404 ||
      ((await (await fetch(`${page}/api/state`)).json()) as { open: boolean }).open === false,
    "revoked: the link no longer collects",
  );
};

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
