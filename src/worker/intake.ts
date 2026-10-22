/**
 * 对方那一侧（/i/<id>.<key>/api/*）的每个动作。门已经在 index.ts 过了；这里每个写动作先确认邀请还在收。
 * 处理到哪一步不另存，都从产物推出来（shared/model.ts）；归类、描述、转写的花费都先在账本里预留（ledger.ts）。
 */
import { isoOf } from "../shared/time.ts";
import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { nowSeconds } from "./clock.ts";
import { Db } from "./db.ts";
import { release, reserve, roundUsage, settle as settleCall } from "./ledger.ts";
import {
  base64Of,
  clef,
  describe as describeImages,
  toMarkdown,
  transcribe,
  MAX_TEXT_CHARS,
  type Media,
} from "./models.ts";
import {
  Refused,
  draftRound,
  currentRound,
  getFile,
  newFileId,
  openness,
  productsOf,
  putNote,
  putProduct,
  r2PrefixOf,
  roundFiles,
  roundNotes,
  setAssignment,
  setFailure,
  submittedRounds,
  type Invite,
} from "./store.ts";
import {
  estimateDescribe,
  estimateSort,
  estimateTranscribe,
  settleDescribe,
  settleSort,
  settleTranscribe,
} from "../shared/budget.ts";
import { lostOf, type ProductMeta, type SourceFacts } from "../shared/facts.ts";
import { ACCEPT_KINDS, KIND_LABEL, sniff, type AcceptKind } from "../shared/kinds.ts";
import { buildManifest, type Manifest } from "../shared/manifest.ts";
import {
  fileState,
  missingOriginal,
  stepsOf,
  type FileRecord,
  type Product,
  type StepState,
} from "../shared/model.ts";
import {
  MAX_VISUALS,
  OPS,
  TRANSCRIBE_SEGMENT_SECONDS,
  producesImages,
  producesText,
  type Step,
} from "../shared/ops.ts";
import {
  howOf,
  promises,
  TRANSIT_MAX_BYTES,
  type PageFile,
  type PageView,
} from "../shared/page.ts";
import { stepIdOf } from "../shared/sha256.ts";
import { decide, sortQuestion, sortState, unsorted } from "../shared/sort.ts";
import { acceptedAnywhere, itemAccepts, pipelineFor, type Snapshot } from "../shared/template.ts";

const refuse = (message: string) => Effect.fail(new Refused({ message }));

const requireOpen = (inv: Invite) =>
  Effect.gen(function* () {
    const why = openness(inv, yield* nowSeconds);
    if (why === "revoked") return yield* refuse("这个链接已经作废了。");
    if (why === "closed") return yield* refuse("这次资料已经收齐，不再收了。");
    if (why === "expired") return yield* refuse("这个链接已经过期了。");
  });

/** 一个文件可能用到的所有步骤：默认处理链，加上每个收这个类型的项的处理链（归类之前就能先做的那些）。 */
const possibleSteps = (snap: Snapshot, kind: AcceptKind): ReadonlyMap<string, Step> => {
  const out = new Map<string, Step>();
  const add = (steps: ReadonlyArray<Step>) => steps.forEach((s) => out.set(stepIdOf(s), s));
  add(pipelineFor(snap, null, kind));
  for (const it of snap.items) if (it.accept.includes(kind)) add(pipelineFor(snap, it.key, kind));
  return out;
};

const fileSteps = (inv: Invite, f: FileRecord) =>
  Effect.map(productsOf(inv.id, f.sha256), (products) => ({
    products,
    steps: stepsOf(inv.snapshot, f, products, stepIdOf),
  }));

const PREVIEW_TEXT = 4000;

const pageFile = (inv: Invite, f: FileRecord) =>
  Effect.map(fileSteps(inv, f), ({ steps }): PageFile => ({
    id: f.id,
    name: f.name,
    path: f.path,
    kind: f.kind,
    bytes: f.bytes,
    sha256: f.sha256,
    facts: f.facts,
    assignment: f.assignment,
    failure: f.failure,
    state: fileState(f, steps),
    steps: steps.map((s) => {
      const def = OPS[s.op];
      const p = s.product;
      const model = def.cls === "model";
      return {
        stepId: s.stepId,
        op: s.op,
        params: s.params,
        input: def.input,
        say: def.say(s.params),
        status: p?.status ?? "missing",
        ...(p ? { meta: p.meta } : {}),
        // 模型产出不给对方（docs/format.md §6）；文字产物给一段预览
        ...(p?.text !== undefined && !model ? { text: p.text.slice(0, PREVIEW_TEXT) } : {}),
        ...(p?.lost ? { lost: p.lost } : {}),
      };
    }),
  }));

// ---- 页面 ----------------------------------------------------------------------------------------

export const view = (inv: Invite) =>
  Effect.gen(function* () {
    const snap = inv.snapshot;
    const now = yield* nowSeconds;
    const round = yield* currentRound(inv.id);
    const files = yield* roundFiles(inv.id, round);
    const pageFiles = yield* Effect.forEach(files, (f) => pageFile(inv, f));
    const notes = yield* roundNotes(inv.id, round);
    const earlier = (yield* submittedRounds(inv.id)).map((r) => {
      const m = JSON.parse(r.manifest) as Manifest;
      return {
        round: r.n,
        submittedAt: m.submittedAt,
        items: m.items.map((it) => ({
          title: it.title,
          status: it.status,
          ...(it.note ? { note: it.note } : {}),
          names: it.files.map((id) => m.files[id]?.name ?? ""),
        })),
        unassigned: m.unassigned.map((id) => m.files[id]?.name ?? ""),
      };
    });
    const why = openness(inv, now);
    return {
      id: inv.id,
      title: snap.title,
      requester: snap.requester,
      intro: snap.intro,
      expiresAt: isoOf(inv.expiresAt),
      open: why === "",
      closedReason: why,
      round,
      rounds: snap.rounds,
      promises: promises(snap),
      items: snap.items.map((it) => ({
        key: it.key,
        title: it.title,
        ask: it.ask,
        accept: it.accept,
        required: it.required,
        allowNone: it.allowNone,
        note: it.note,
        count: it.count,
        how: howOf(snap, it.key),
      })),
      acceptAny: acceptedAnywhere(snap, "any"),
      files: pageFiles,
      notes,
      earlier,
      limits: { maxFiles: snap.maxFiles, transitBytes: TRANSIT_MAX_BYTES },
    } satisfies PageView;
  });

// ---- 放进来一个文件 ----------------------------------------------------------------------------------

export type NewFile = {
  readonly name: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly kind: AcceptKind;
  readonly mime: string;
  readonly facts: SourceFacts;
  /** 放在某一项里（单独补传）：归属直接记 client。 */
  readonly item: string | null;
};

const factsOf = (x: unknown): SourceFacts => {
  const o = typeof x === "object" && x !== null ? (x as Record<string, unknown>) : {};
  const n = (k: string) =>
    typeof o[k] === "number" && Number.isFinite(o[k]) && (o[k] as number) >= 0
      ? (o[k] as number)
      : undefined;
  const out: Record<string, number | boolean> = {};
  for (const k of ["width", "height", "duration", "pages", "slides"]) {
    const v = n(k);
    if (v !== undefined) out[k] = v;
  }
  if (typeof o["hasAudio"] === "boolean") out["hasAudio"] = o["hasAudio"];
  return out as SourceFacts;
};

export const parseNewFile = (body: Readonly<Record<string, unknown>>): NewFile | string => {
  const s = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
  const name = s("name").slice(0, 255);
  const path = s("path").slice(0, 1000) || name;
  const bytes = body["bytes"];
  if (!name) return "name is required";
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0)
    return "bytes must be a non-negative integer";
  if (!/^[0-9a-f]{64}$/.test(s("sha256"))) return "sha256 must be 64 hex characters";
  const kind = s("kind");
  if (!(ACCEPT_KINDS as ReadonlyArray<string>).includes(kind)) return "unknown kind";
  return {
    name,
    path,
    bytes,
    sha256: s("sha256"),
    kind: kind as AcceptKind,
    mime: s("mime").slice(0, 120) || "application/octet-stream",
    facts: factsOf(body["facts"]),
    item: s("item") || null,
  };
};

export const addFile = (inv: Invite, nf: NewFile) =>
  Effect.gen(function* () {
    yield* requireOpen(inv);
    const snap = inv.snapshot;
    const db = yield* Db;
    const round = yield* draftRound(inv.id);
    if (nf.item !== null && !snap.items.some((i) => i.key === nf.item))
      return yield* refuse("没有这一项。");
    const toItem = nf.item !== null && itemAccepts(snap, nf.item, nf.kind) ? nf.item : null;
    if (toItem === null && !acceptedAnywhere(snap, nf.kind))
      return yield* refuse(`这次不收${KIND_LABEL[nf.kind]}。`);
    if (nf.kind === "any" && toItem === null)
      return yield* refuse("这种文件只能放进收原件的那一项。");
    // 同一轮里同一路径、同一内容再放一次：就是原来那个
    const same = (yield* roundFiles(inv.id, round)).find(
      (f) => f.path === nf.path && f.sha256 === nf.sha256,
    );
    if (same) return yield* pageFile(inv, same);
    const count = (yield* roundFiles(inv.id, round)).length;
    if (count >= snap.maxFiles) return yield* refuse(`这一轮最多 ${snap.maxFiles} 个文件。`);
    const id = yield* newFileId;
    const assignment = toItem ? JSON.stringify({ item: toItem, by: "client" }) : null;
    yield* db.run(
      `INSERT INTO files (id, invite_id, round, name, path, kind, mime, bytes, sha256, facts, assignment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        inv.id,
        round,
        nf.name,
        nf.path,
        nf.kind,
        nf.mime,
        nf.bytes,
        nf.sha256,
        JSON.stringify(nf.facts),
        assignment,
        yield* nowSeconds,
      ],
    );
    if (toItem)
      yield* putNote(
        inv.id,
        round,
        toItem,
        false,
        (yield* roundNotes(inv.id, round))[toItem]?.note ?? "",
      );
    return yield* pageFile(inv, yield* getFile(inv.id, id));
  });

/** 对方页面上的文件只能动草稿轮的。 */
const draftFile = (inv: Invite, fileId: string) =>
  Effect.gen(function* () {
    yield* requireOpen(inv);
    const f = yield* getFile(inv.id, fileId);
    if (f.round !== (yield* currentRound(inv.id))) return yield* refuse("已经提交的文件不能再改。");
    return f;
  });

const stepOf = (inv: Invite, f: FileRecord, stepId: string) =>
  Effect.gen(function* () {
    const s = possibleSteps(inv.snapshot, f.kind).get(stepId);
    if (!s) return yield* refuse("这个文件没有这一步。");
    return s;
  });

// ---- 产物：浏览器端做的 ------------------------------------------------------------------------------

const MAX_PRODUCT_FILE = 25 * 1024 * 1024;
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,60}$/;

export const putBrowserProduct = (inv: Invite, fileId: string, stepId: string, form: FormData) =>
  Effect.gen(function* () {
    const f = yield* draftFile(inv, fileId);
    const step = yield* stepOf(inv, f, stepId);
    if (OPS[step.op].input !== "browser") return yield* refuse("这一步不在浏览器里做。");
    const metaText = form.get("meta");
    const meta = (typeof metaText === "string" ? JSON.parse(metaText) : {}) as ProductMeta & {
      files?: string[];
    };
    const blobs = form.getAll("file").filter((x): x is File => typeof x !== "string");
    const prefix = r2PrefixOf(inv.id, f.sha256, stepId);
    const names: string[] = [];
    let total = 0;
    for (const b of blobs) {
      if (!SAFE_NAME.test(b.name) || b.size > MAX_PRODUCT_FILE)
        return yield* refuse("产物文件名或大小不对。");
      if (!/^image\/(webp|jpeg|png)$/.test(b.type))
        return yield* refuse("产物只能是 WebP / JPEG / PNG 图片。");
      total += b.size;
      yield* Effect.promise(() =>
        env.FILES.put(prefix + b.name, b.stream(), { httpMetadata: { contentType: b.type } }),
      );
      names.push(b.name);
    }
    const textField = form.get("text");
    const text = typeof textField === "string" ? textField : undefined;
    if (text !== undefined && text.length > MAX_TEXT_CHARS * 1.2)
      return yield* refuse("文字太长了。");
    const clipped =
      text !== undefined && text.length > MAX_TEXT_CHARS
        ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n…（超过 1 MB 的部分截掉了）`
        : text;
    const fullMeta: ProductMeta & { files: string[] } = {
      ...meta,
      files: names,
      bytes: total || (clipped !== undefined ? new TextEncoder().encode(clipped).length : 0),
      ...(clipped !== undefined ? { chars: clipped.length } : {}),
    };
    yield* putProduct({
      inviteId: inv.id,
      sha256: f.sha256,
      stepId,
      op: step.op,
      params: step.params,
      status: "done",
      meta: fullMeta,
      ...(clipped !== undefined ? { text: clipped } : {}),
      ...(lostOf(step.op, step.params, f.facts, fullMeta)
        ? { lost: lostOf(step.op, step.params, f.facts, fullMeta) }
        : {}),
      r2Prefix: names.length ? prefix : undefined,
    });
    return yield* pageFile(inv, f);
  });

/** 对方能修的失败（浏览器解不了、文件坏了）：记下，当场告诉对方。 */
export const reportFailure = (inv: Invite, fileId: string, op: string, reason: string) =>
  Effect.gen(function* () {
    const f = yield* draftFile(inv, fileId);
    yield* setFailure(f.id, { op: op.slice(0, 40), reason: reason.slice(0, 300) });
    return yield* pageFile(inv, yield* getFile(inv.id, f.id));
  });

/**
 * 视频的转写由浏览器跳过：没有音轨（not-applicable），或浏览器解不了它的音轨（decode-error，我们这边的问题，不挡对方）。
 * 录音本身解不了是文件的问题，走 reportFailure。
 */
export const markSkipped = (inv: Invite, fileId: string, stepId: string, reason: string) =>
  Effect.gen(function* () {
    const f = yield* draftFile(inv, fileId);
    const step = yield* stepOf(inv, f, stepId);
    if (step.op !== "transcribe" || f.kind !== "video")
      return yield* refuse("只有视频的转写可以由页面跳过。");
    if (reason !== "not-applicable" && reason !== "decode-error")
      return yield* refuse("跳过的原因不对。");
    yield* putProduct({
      inviteId: inv.id,
      sha256: f.sha256,
      stepId,
      op: step.op,
      params: step.params,
      status: "skipped",
      reason,
    });
    return yield* pageFile(inv, f);
  });

// ---- 产物：原件过境（toMarkdown） --------------------------------------------------------------------

const hex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export const transit = (inv: Invite, fileId: string, stepId: string, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const f = yield* draftFile(inv, fileId);
    const step = yield* stepOf(inv, f, stepId);
    if (OPS[step.op].input !== "transit") return yield* refuse("这一步不是服务器转换。");
    if (bytes.length !== f.bytes) return yield* refuse("收到的内容和登记的大小不一样。");
    const digest = hex(
      yield* Effect.promise(() =>
        crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
      ),
    );
    if (digest !== f.sha256)
      return yield* refuse("收到的内容和登记的不一样，请重新放一次这个文件。");
    const sniffed = sniff(f.name, bytes.subarray(0, 4096));
    if (!sniffed.ok || sniffed.kind !== f.kind)
      return yield* refuse(sniffed.ok ? "文件类型和登记的不一样。" : sniffed.reason);
    // 转换出错是我们这边的问题（§2.3）：记 skipped，不挡对方
    const md = yield* toMarkdown(f.name, sniffed.mime, bytes).pipe(Effect.result);
    if (md._tag === "Failure") {
      yield* putProduct({
        inviteId: inv.id,
        sha256: f.sha256,
        stepId,
        op: step.op,
        params: step.params,
        status: "skipped",
        reason: `convert-error: ${md.failure.message.slice(0, 200)}`,
      });
      return yield* pageFile(inv, f);
    }
    const text =
      md.success.length > MAX_TEXT_CHARS
        ? `${md.success.slice(0, MAX_TEXT_CHARS)}\n\n…（超过 1 MB 的部分截掉了）`
        : md.success;
    const meta: ProductMeta = {
      mime: "text/markdown",
      bytes: new TextEncoder().encode(text).length,
      chars: text.trim().length,
    };
    yield* putProduct({
      inviteId: inv.id,
      sha256: f.sha256,
      stepId,
      op: step.op,
      params: step.params,
      status: "done",
      meta,
      text,
      ...(lostOf(step.op, step.params, f.facts, meta)
        ? { lost: lostOf(step.op, step.params, f.facts, meta) }
        : {}),
    });
    return yield* pageFile(inv, f);
  });

// ---- 产物：转写（一段一段来） ----------------------------------------------------------------------------

export const audioSegment = (
  inv: Invite,
  fileId: string,
  stepId: string,
  seg: {
    readonly index: number;
    readonly last: boolean;
    readonly start: number;
    readonly duration: number;
  },
  wav: Uint8Array,
) =>
  Effect.gen(function* () {
    const f = yield* draftFile(inv, fileId);
    const step = yield* stepOf(inv, f, stepId);
    if (step.op !== "transcribe") return yield* refuse("这一步不是转写。");
    if (
      !(
        Number.isInteger(seg.index) &&
        seg.index >= 0 &&
        seg.duration > 0 &&
        seg.duration <= TRANSCRIBE_SEGMENT_SECONDS + 0.5
      )
    )
      return yield* refuse("分段的编号或时长不对。");
    const existing = (yield* productsOf(inv.id, f.sha256)).get(stepId);
    if (existing && existing.status !== "partial") return yield* pageFile(inv, f);
    const done = existing?.meta.segmentsDone ?? 0;
    if (seg.index !== done) return yield* refuse(`请从第 ${done + 1} 段接着传。`);
    const round = yield* currentRound(inv.id);
    const model = String(step.params["model"]);
    const reservation = yield* reserve(
      inv.id,
      round,
      "transcribe",
      model,
      estimateTranscribe(seg.duration),
    );
    const skip = (reason: string) =>
      putProduct({
        inviteId: inv.id,
        sha256: f.sha256,
        stepId,
        op: step.op,
        params: step.params,
        status: "skipped",
        reason,
        model,
      });
    if (reservation === null) {
      yield* skip("budget");
      return yield* pageFile(inv, f);
    }
    const r = yield* transcribe(
      model,
      wav,
      String(step.params["language"] ?? ""),
      String(step.params["prompt"] ?? ""),
      step.params["vad"] === true,
      seg.start,
    ).pipe(Effect.result);
    if (r._tag === "Failure") {
      yield* release(reservation);
      yield* skip(`model-error: ${r.failure.message.slice(0, 200)}`);
      return yield* pageFile(inv, f);
    }
    yield* settleCall(reservation, settleTranscribe(seg.duration));
    const text = [existing?.text ?? "", r.success.text].filter((x) => x !== "").join("\n");
    const segments = [...(existing?.segments ?? []), ...r.success.segments];
    const last = seg.last;
    yield* putProduct({
      inviteId: inv.id,
      sha256: f.sha256,
      stepId,
      op: step.op,
      params: step.params,
      status: last ? "done" : "partial",
      meta: {
        segmentsDone: done + 1,
        ...(last ? { segmentsTotal: done + 1 } : {}),
        chars: text.length,
      },
      text,
      segments,
      model,
    });
    return yield* pageFile(inv, f);
  });

// ---- 归类 ----------------------------------------------------------------------------------------

/** 产物里的图片（最多 4 张，按处理链顺序；联系表优先于单帧）。 */
const imagesOf = (
  inv: Invite,
  f: FileRecord,
  steps: ReadonlyArray<StepState>,
  limit = MAX_VISUALS,
) =>
  Effect.gen(function* () {
    const keys: string[] = [];
    for (const s of steps) {
      const p = s.product;
      if (!p || p.status !== "done" || !producesImages(s.op)) continue;
      const files = p.meta.files ?? [];
      const pick = s.op === "video.frames" && p.meta.sheet ? [files.at(-1) ?? ""] : files;
      for (const name of pick) if (name) keys.push(r2PrefixOf(inv.id, f.sha256, s.stepId) + name);
    }
    const out: Media[] = [];
    for (const key of keys.slice(0, limit)) {
      const obj = yield* Effect.promise(() => env.FILES.get(key));
      if (!obj) continue;
      const buf = new Uint8Array(yield* Effect.promise(() => obj.arrayBuffer()));
      if (buf.length > 4 * 1024 * 1024) continue; // clef / DeepSeek 一张图 ≤ 4 MiB
      out.push({
        content_type: obj.httpMetadata?.contentType ?? "image/webp",
        base64: base64Of(buf),
      });
    }
    return { media: out, read: keys.slice(0, out.length) };
  });

const textOf = (steps: ReadonlyArray<StepState>): string =>
  steps
    .filter((s) => s.product?.status === "done" && producesText(s.op) && s.product.text)
    .map((s) => s.product!.text!)
    .join("\n\n");

/**
 * 归类一个总区里的文件（§3）。录音：浏览器把开头一段（≤ 240 秒，16 kHz 单声道 WAV）放在请求体里给 clef-omni 听；
 * 其余：读它在默认处理链下的产物（图片 + 文字开头）给 clef-flash。没有分数就未分类，写明原因。
 */
export const sortFile = (
  inv: Invite,
  fileId: string,
  clip: Uint8Array | null,
  clipSeconds: number,
) =>
  Effect.gen(function* () {
    const f = yield* draftFile(inv, fileId);
    if (f.assignment !== null) return yield* pageFile(inv, f);
    const snap = inv.snapshot;
    const { steps } = yield* fileSteps(inv, f);
    const question = sortQuestion(snap, f.kind);
    const criteriaChars = Object.values(question.criteria).join("").length;
    const text = textOf(steps).slice(0, snap.sort.textChars);
    const audio =
      f.kind === "audio" && clip !== null && clip.length > 0 && clip.length <= 8 * 1024 * 1024;
    const { media } = audio ? { media: [] as Media[] } : yield* imagesOf(inv, f, steps);
    const model = audio ? snap.sort.audioModel : snap.sort.model;
    const round = yield* currentRound(inv.id);
    const reservation = yield* reserve(
      inv.id,
      round,
      "sort",
      model,
      estimateSort(
        media.length,
        text.length + f.path.length,
        criteriaChars,
        audio ? Math.min(clipSeconds, 300) : 0,
      ),
    );
    if (reservation === null) {
      yield* setAssignment(f.id, unsorted(snap, f.kind, "budget"));
      return yield* pageFile(inv, yield* getFile(inv.id, f.id));
    }
    const answer = yield* clef(
      model as "@cf/cloudflare/clef-flash" | "@cf/cloudflare/clef-omni",
      sortState(snap, { path: f.path, kind: f.kind, text }),
      question,
      audio
        ? { audio: [{ content_type: "audio/wav", base64: base64Of(clip) }] }
        : { images: media },
    ).pipe(Effect.result);
    if (answer._tag === "Failure") {
      yield* release(reservation);
      yield* setAssignment(f.id, unsorted(snap, f.kind, "model-error"));
      return yield* pageFile(inv, yield* getFile(inv.id, f.id));
    }
    yield* settleCall(
      reservation,
      settleSort(answer.success.inputTokens, audio) || reservation.estimate,
    );
    yield* setAssignment(f.id, decide(snap, f.kind, model, answer.success.probabilities));
    return yield* pageFile(inv, yield* getFile(inv.id, f.id));
  });

// ---- 描述：服务端读已存的图片产物 -----------------------------------------------------------------------

/** 跑这个文件当前处理链里还没做的 describe（读排在它前面的图片产物）。没做完的图片产物 → 还不能做，等下一次。 */
export const runDescribe = (inv: Invite, fileId: string) =>
  Effect.gen(function* () {
    const f = yield* getFile(inv.id, fileId);
    const { steps } = yield* fileSteps(inv, f);
    const round = yield* currentRound(inv.id);
    for (const [i, s] of steps.entries()) {
      if (s.op !== "describe" || s.product !== undefined) continue;
      const before = steps.slice(0, i);
      if (
        before.some(
          (b) =>
            producesImages(b.op) && b.product?.status !== "done" && b.product?.status !== "skipped",
        )
      )
        continue;
      const { media, read } = yield* imagesOf(inv, f, before);
      const model = String(s.params["model"]);
      const write = (extra: { status: "done" | "skipped"; reason?: string; text?: string }) =>
        putProduct({
          inviteId: inv.id,
          sha256: f.sha256,
          stepId: s.stepId,
          op: s.op,
          params: s.params,
          model,
          ...extra,
          reads: read,
        });
      if (media.length === 0) {
        yield* write({ status: "skipped", reason: "no-images" });
        continue;
      }
      const prompt = String(s.params["prompt"]);
      const maxTokens = Number(s.params["maxTokens"]);
      const reservation = yield* reserve(
        inv.id,
        round,
        "describe",
        model,
        estimateDescribe(media.length, prompt.length, maxTokens),
      );
      if (reservation === null) {
        yield* write({ status: "skipped", reason: "budget" });
        continue;
      }
      const r = yield* describeImages(
        model,
        prompt,
        media,
        maxTokens,
        String(s.params["reasoning"]),
      ).pipe(Effect.result);
      if (r._tag === "Failure") {
        yield* release(reservation);
        yield* write({
          status: "skipped",
          reason: `model-error: ${r.failure.message.slice(0, 200)}`,
        });
        continue;
      }
      yield* settleCall(
        reservation,
        settleDescribe(r.success.promptTokens, r.success.completionTokens) || reservation.estimate,
      );
      yield* write({ status: "done", text: r.success.text });
    }
    return yield* pageFile(inv, yield* getFile(inv.id, f.id));
  });

// ---- 对方的归类、删除、声明 -----------------------------------------------------------------------------

export const assign = (inv: Invite, fileId: string, item: string) =>
  Effect.gen(function* () {
    const f = yield* draftFile(inv, fileId);
    if (!itemAccepts(inv.snapshot, item, f.kind))
      return yield* refuse(`这一项不收${KIND_LABEL[f.kind]}。`);
    const scores = f.assignment && "scores" in f.assignment ? f.assignment.scores : undefined;
    yield* setAssignment(f.id, { item, by: "client", ...(scores ? { scores } : {}) });
    const round = f.round;
    const notes = yield* roundNotes(inv.id, round);
    if (notes[item]?.none) yield* putNote(inv.id, round, item, false, notes[item]?.note ?? "");
    return yield* pageFile(inv, yield* getFile(inv.id, f.id));
  });

export const removeFile = (inv: Invite, fileId: string) =>
  Effect.gen(function* () {
    const f = yield* draftFile(inv, fileId);
    yield* (yield* Db).run("DELETE FROM files WHERE id = ?", [f.id]);
  });

export const note = (inv: Invite, item: string, none: boolean, text: string) =>
  Effect.gen(function* () {
    yield* requireOpen(inv);
    const it = inv.snapshot.items.find((i) => i.key === item);
    if (!it) return yield* refuse("没有这一项。");
    if (none && !it.allowNone) return yield* refuse("这一项不能声明没有。");
    if (it.note === "off" && text !== "") return yield* refuse("这一项不收补充说明。");
    if (text.length > 2000) return yield* refuse("补充说明最多 2000 字。");
    const round = yield* draftRound(inv.id);
    if (none && (yield* roundFiles(inv.id, round)).some((f) => f.assignment?.item === item))
      return yield* refuse("这一项已经有文件了。");
    yield* putNote(inv.id, round, item, none, text);
  });

// ---- 原件（file.keep）：提交时分片上传 ----------------------------------------------------------------

const keepStep = (inv: Invite, f: FileRecord, stepId: string) =>
  Effect.gen(function* () {
    const step = pipelineFor(inv.snapshot, f.assignment?.item ?? null, f.kind).find(
      (s) => stepIdOf(s) === stepId,
    );
    if (!step || step.op !== "file.keep") return yield* refuse("这个文件所在的项不收原件。");
    if (f.bytes > Number(step.params["maxBytes"]))
      return yield* refuse("这个文件超过了原件的大小上限。");
    return step;
  });
const originalKey = (inv: Invite, f: FileRecord, stepId: string) =>
  `${r2PrefixOf(inv.id, f.sha256, stepId)}original${
    f.name.includes(".")
      ? `.${f.name
          .split(".")
          .pop()!
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .slice(0, 10)}`
      : ""
  }`;

export const originalStart = (inv: Invite, fileId: string, stepId: string) =>
  Effect.gen(function* () {
    const f = yield* draftFile(inv, fileId);
    yield* keepStep(inv, f, stepId);
    const key = originalKey(inv, f, stepId);
    const up = yield* Effect.promise(() =>
      env.FILES.createMultipartUpload(key, { httpMetadata: { contentType: f.mime } }),
    );
    return { uploadId: up.uploadId };
  });

export const originalPart = (
  inv: Invite,
  fileId: string,
  stepId: string,
  uploadId: string,
  part: number,
  body: ReadableStream | ArrayBuffer,
) =>
  Effect.gen(function* () {
    const f = yield* draftFile(inv, fileId);
    yield* keepStep(inv, f, stepId);
    if (!Number.isInteger(part) || part < 1 || part > 10000) return yield* refuse("分片编号不对。");
    const up = env.FILES.resumeMultipartUpload(originalKey(inv, f, stepId), uploadId);
    const r = yield* Effect.promise(() => up.uploadPart(part, body));
    return { partNumber: r.partNumber, etag: r.etag };
  });

export const originalComplete = (
  inv: Invite,
  fileId: string,
  stepId: string,
  uploadId: string,
  parts: ReadonlyArray<{ readonly partNumber: number; readonly etag: string }>,
) =>
  Effect.gen(function* () {
    const f = yield* draftFile(inv, fileId);
    const step = yield* keepStep(inv, f, stepId);
    const key = originalKey(inv, f, stepId);
    const up = env.FILES.resumeMultipartUpload(key, uploadId);
    const obj = yield* Effect.promise(() => up.complete([...parts]));
    if (obj.size !== f.bytes) {
      yield* Effect.promise(() => env.FILES.delete(key));
      return yield* refuse("原件上传不完整，请再提交一次。");
    }
    const name = key.split("/").pop()!;
    yield* putProduct({
      inviteId: inv.id,
      sha256: f.sha256,
      stepId,
      op: step.op,
      params: step.params,
      status: "done",
      meta: { files: [name], mime: f.mime, bytes: f.bytes },
      r2Prefix: r2PrefixOf(inv.id, f.sha256, stepId),
    });
    return yield* pageFile(inv, f);
  });

// ---- 提交 ----------------------------------------------------------------------------------------

export type SubmitProblem = { readonly message: string; readonly files?: ReadonlyArray<string> };

export const submit = (inv: Invite) =>
  Effect.gen(function* () {
    yield* requireOpen(inv);
    const snap = inv.snapshot;
    const db = yield* Db;
    const round = yield* currentRound(inv.id);
    const files = yield* roundFiles(inv.id, round);
    const notes = yield* roundNotes(inv.id, round);
    const withSteps = yield* Effect.forEach(files, (f) =>
      Effect.map(fileSteps(inv, f), (x) => ({ file: f, ...x })),
    );
    const problems: SubmitProblem[] = [];
    const failed = withSteps.filter((x) => fileState(x.file, x.steps) === "failed");
    if (failed.length)
      problems.push({
        message: `${failed.length} 个文件没处理成功，换一个或删掉`,
        files: failed.map((x) => x.file.id),
      });
    const busy = withSteps.filter((x) => fileState(x.file, x.steps) === "processing");
    if (busy.length)
      problems.push({
        message: `还有 ${busy.length} 个文件在处理`,
        files: busy.map((x) => x.file.id),
      });
    const noOriginal = withSteps.filter((x) => missingOriginal(x.steps));
    if (noOriginal.length)
      problems.push({
        message: `${noOriginal.length} 个原件还没传完`,
        files: noOriginal.map((x) => x.file.id),
      });
    for (const it of snap.items) {
      const n = files.filter((f) => f.assignment?.item === it.key).length;
      if (it.required && n < it.count.min && !notes[it.key]?.none)
        problems.push({ message: `「${it.title}」还没有` });
      if (n > it.count.max)
        problems.push({ message: `「${it.title}」最多 ${it.count.max} 个文件` });
      if (it.note === "required" && !(notes[it.key]?.note ?? "").trim())
        problems.push({ message: `「${it.title}」要写一句说明` });
    }
    if (files.length === 0 && !Object.values(notes).some((n) => n.none || n.note.trim()))
      problems.push({ message: "还没有交任何东西" });
    if (problems.length) return { ok: false as const, problems };

    // 没跑的 describe（对方关了页面）：记成 skipped，不替它补跑（提交要快，不让对方等模型）
    for (const x of withSteps)
      for (const s of x.steps)
        if (s.product === undefined && OPS[s.op].cls === "model")
          yield* putProduct({
            inviteId: inv.id,
            sha256: x.file.sha256,
            stepId: s.stepId,
            op: s.op,
            params: s.params,
            status: "skipped",
            reason: "not-run",
          });

    const now = yield* nowSeconds;
    const final = yield* Effect.forEach(files, (f) =>
      Effect.map(productsOf(inv.id, f.sha256), (products) => ({
        file: f,
        products: stepsOf(snap, f, products, stepIdOf).flatMap((s) =>
          s.product ? [s.product] : [],
        ) as ReadonlyArray<Product>,
      })),
    );
    const manifest = buildManifest({
      inviteId: inv.id,
      ref: inv.ref,
      round,
      submittedAt: now,
      snapshot: snap,
      files: final,
      notes,
      usage: yield* roundUsage(inv.id, round),
    });
    const changed = yield* db.run(
      "UPDATE rounds SET submitted_at = ?, manifest = ? WHERE invite_id = ? AND n = ? AND submitted_at IS NULL",
      [now, JSON.stringify(manifest), inv.id, round],
    );
    if (changed === 0) return { ok: false as const, problems: [{ message: "这一轮已经提交过了" }] };
    if (snap.rounds === "one")
      yield* db.run(
        "UPDATE invites SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'",
        [now, inv.id],
      );
    return { ok: true as const, round };
  });

/** 草稿轮里文件的产物预览（只限草稿轮：已提交的资料这个链接看不到）。 */
export const preview = (inv: Invite, fileId: string, stepId: string, name: string) =>
  Effect.gen(function* () {
    const f = yield* getFile(inv.id, fileId);
    if (f.round !== (yield* currentRound(inv.id))) return null;
    if (!SAFE_NAME.test(name) || name.startsWith("original")) return null;
    return yield* Effect.promise(() => env.FILES.get(r2PrefixOf(inv.id, f.sha256, stepId) + name));
  });
