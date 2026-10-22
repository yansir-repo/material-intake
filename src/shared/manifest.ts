/**
 * 一轮提交的输出（docs/format.md §8）：manifest.json 由存下来的事实确定地生成；MAP.md 由 manifest 渲染，不写结论。
 * 提交那一刻生成并冻结（轮次只追加）。
 */
import { isoOf } from "./time.ts";
import type { SourceFacts } from "./facts.ts";
import type { AcceptKind } from "./kinds.ts";
import { OPS, type OpName, type Params } from "./ops.ts";
import type { FileRecord, Product } from "./model.ts";
import type { Assignment } from "./sort.ts";
import type { Snapshot } from "./template.ts";

export const SCHEMA = "material-intake/2";

export type Artifact = {
  readonly op: OpName;
  readonly class: "exact" | "lossy" | "model";
  readonly params: Params;
  readonly status?: "skipped";
  readonly reason?: string;
  /** 一个文件的产物：路径；多个文件（切块、帧、页）：目录 + files。 */
  readonly path?: string;
  readonly files?: ReadonlyArray<string>;
  readonly mime?: string;
  readonly bytes?: number;
  readonly width?: number;
  readonly height?: number;
  readonly format?: string;
  readonly frames?: ReadonlyArray<{ readonly t: number; readonly path: string }>;
  readonly sheet?: string;
  readonly tiles?: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly path: string;
  }>;
  readonly pages?: number;
  readonly text?: string;
  readonly segments?: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
    readonly text: string;
  }>;
  readonly model?: string;
  readonly reads?: ReadonlyArray<string>;
  readonly lost?: string;
};

export type ManifestFile = {
  readonly name: string;
  readonly path: string;
  readonly source: {
    readonly kind: AcceptKind;
    readonly mime: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly duplicateOf?: string;
  } & SourceFacts;
  readonly assignment: Assignment;
  readonly artifacts: ReadonlyArray<Artifact>;
};

export type Usage = {
  readonly usd: number;
  readonly calls: Readonly<Record<"sort" | "describe" | "transcribe", number>>;
  readonly skipped: { readonly budget: number };
};

export type Manifest = {
  readonly schema: typeof SCHEMA;
  readonly invite: string;
  readonly ref: string;
  readonly round: number;
  readonly submittedAt: string;
  readonly usage: Usage;
  readonly items: ReadonlyArray<{
    readonly key: string;
    readonly title: string;
    readonly status: "provided" | "none" | "empty";
    readonly note?: string;
    readonly files: ReadonlyArray<string>;
  }>;
  readonly unassigned: ReadonlyArray<string>;
  readonly files: Readonly<Record<string, ManifestFile>>;
};

/** 输出里一个产物的目录：`files/<文件 id>/<步骤 id>`。 */
export const artifactDir = (fileId: string, stepId: string): string => `files/${fileId}/${stepId}`;

const artifactOf = (fileId: string, p: Product): Artifact => {
  const dir = artifactDir(fileId, p.stepId);
  const base = { op: p.op, class: OPS[p.op].cls, params: p.params } as const;
  if (p.status === "skipped") return { ...base, status: "skipped", reason: p.reason ?? "" };
  const m = p.meta;
  const files = (m.files ?? []).map((n) => `${dir}/${n}`);
  const one = files.length === 1 ? files[0] : undefined;
  switch (p.op) {
    case "describe":
      return { ...base, model: p.model, reads: p.reads ?? [], text: p.text ?? "" };
    case "transcribe":
      return {
        ...base,
        model: p.model,
        path: `${dir}/transcript.md`,
        text: p.text ?? "",
        segments: p.segments ?? [],
      };
    case "pdf.markdown":
    case "doc.markdown":
    case "slides.text":
    case "text.keep":
      return {
        ...base,
        path: `${dir}/text.md`,
        mime: "text/markdown",
        bytes: m.bytes,
        ...(p.lost ? { lost: p.lost } : {}),
      };
    case "video.frames":
      return {
        ...base,
        path: dir,
        frames: (m.frames ?? []).map((t, i) => ({ t, path: files[i] ?? "" })),
        ...(m.sheet ? { sheet: files.at(-1) } : {}),
        width: m.width,
        height: m.height,
        bytes: m.bytes,
        lost: p.lost,
      };
    case "image.tile":
      return {
        ...base,
        path: dir,
        tiles: (m.tiles ?? []).map((t, i) => ({ ...t, path: files[i] ?? "" })),
        bytes: m.bytes,
        lost: p.lost,
      };
    case "pdf.pages":
      return { ...base, path: dir, files, pages: m.pages, bytes: m.bytes, lost: p.lost };
    case "image.resize":
      return {
        ...base,
        path: one ?? dir,
        mime: m.mime,
        bytes: m.bytes,
        width: m.width,
        height: m.height,
        format: m.format,
        lost: p.lost,
      };
    case "file.keep":
      return { ...base, path: one ?? dir, mime: m.mime, bytes: m.bytes };
  }
};

export type RoundInput = {
  readonly inviteId: string;
  readonly ref: string;
  readonly round: number;
  readonly submittedAt: number;
  readonly snapshot: Snapshot;
  /** 这一轮的文件，和每个文件按最终处理链排好的产物。失败的文件不在这里（不能带着失败提交）。 */
  readonly files: ReadonlyArray<{
    readonly file: FileRecord;
    readonly products: ReadonlyArray<Product>;
  }>;
  readonly notes: Readonly<Record<string, { readonly none: boolean; readonly note: string }>>;
  readonly usage: Usage;
};

export const buildManifest = (r: RoundInput): Manifest => {
  const files: Record<string, ManifestFile> = {};
  for (const { file: f, products } of r.files) {
    if (f.assignment === null) continue;
    files[f.id] = {
      name: f.name,
      path: f.path,
      source: {
        kind: f.kind,
        mime: f.mime,
        bytes: f.bytes,
        sha256: f.sha256,
        ...f.facts,
        ...(f.duplicateOf ? { duplicateOf: f.duplicateOf } : {}),
      },
      assignment: f.assignment,
      artifacts: products.map((p) => artifactOf(f.id, p)),
    };
  }
  const ids = Object.keys(files);
  return {
    schema: SCHEMA,
    invite: r.inviteId,
    ref: r.ref,
    round: r.round,
    submittedAt: isoOf(r.submittedAt),
    usage: r.usage,
    items: r.snapshot.items.map((it) => {
      const mine = ids.filter((id) => files[id]!.assignment.item === it.key);
      const n = r.notes[it.key];
      const status = n?.none ? "none" : mine.length ? "provided" : "empty";
      return {
        key: it.key,
        title: it.title,
        status,
        ...(n?.note ? { note: n.note } : {}),
        files: status === "none" ? [] : mine,
      };
    }),
    unassigned: ids.filter((id) => files[id]!.assignment.item === null),
    files,
  };
};

// ---- MAP.md ------------------------------------------------------------------------------------

const size = (n: number | undefined): string =>
  n === undefined
    ? ""
    : n < 1024
      ? `${n} B`
      : n < 1048576
        ? `${Math.round(n / 1024)} KB`
        : `${(n / 1048576).toFixed(1)} MB`;
const cell = (s: string): string => s.replaceAll("|", "\\|").replaceAll("\n", " ");

const origin = (f: ManifestFile): string => {
  const s = f.source;
  return [
    s.width ? `${s.width}×${s.height}` : "",
    s.duration ? `${Math.round(s.duration * 10) / 10}s${s.hasAudio ? " 有声" : ""}` : "",
    s.pages ? `${s.pages} 页` : "",
    s.slides ? `${s.slides} 页` : "",
    size(s.bytes),
  ]
    .filter(Boolean)
    .join(" · ");
};

const byOf = (a: Assignment): string =>
  a.by === "client"
    ? "对方放的"
    : a.by === "model"
      ? `自动 ${a.p.toFixed(2)}`
      : a.reason
        ? `未分类（${a.reason}）`
        : `拿不准 ${(a.p ?? 0).toFixed(2)}`;

const fileRows = (id: string, f: ManifestFile): string[] => {
  const rows: string[] = [];
  const models = f.artifacts.filter((a) => a.class === "model" && a.status !== "skipped");
  const head = `${cell(f.path)}<br>${id} · ${byOf(f.assignment)}`;
  const arts = f.artifacts.filter((a) => a.class !== "model" || a.status === "skipped");
  const lines = [
    ...arts.map((a) => ({
      product:
        a.status === "skipped"
          ? `${a.op}（跳过：${a.reason}）`
          : `${a.op}<br>${cell(a.path ?? "")}`,
      note: cell(a.lost ?? (a.op === "file.keep" ? "原件，无损" : "")),
    })),
    ...models.map((m) => ({
      product: `${m.op === "transcribe" ? "模型转写" : "模型描述"}（${m.model ?? ""}）${m.path ? `<br>${cell(m.path)}` : ""}`,
      note: `${cell((m.text ?? "").slice(0, 400))}${(m.text ?? "").length > 400 ? "…" : ""}`,
    })),
  ];
  if (lines.length === 0) lines.push({ product: "", note: "" });
  lines.forEach((l, i) =>
    rows.push(
      `| ${i === 0 ? head : ""} | ${i === 0 ? origin(f) : ""} | ${l.product} | ${l.note} |`,
    ),
  );
  return rows;
};

export const renderMap = (m: Manifest): string => {
  const out: string[] = [
    `# 资料地图 · ${m.ref || m.invite} · 第 ${m.round} 轮`,
    "",
    `${m.invite} · 提交于 ${m.submittedAt} · 由 manifest.json 渲染，不写结论。`,
    "",
    "「对方放的」是对方自己归的类；「自动」是模型分的（带分数），对方没改过不等于确认过。模型描述、模型转写是模型产出，不是对方的原话。",
    "",
  ];
  const table = (ids: ReadonlyArray<string>): string[] => [
    "| 文件 · 归属 | 原规格 | 产物 | 丢掉的 / 模型产出 |",
    "| --- | --- | --- | --- |",
    ...ids.flatMap((id) => fileRows(id, m.files[id]!)),
    "",
  ];
  for (const it of m.items) {
    out.push(`## ${it.title}（${it.key} · ${it.status}）`, "");
    if (it.note) out.push(`> 对方原话：${it.note}`, "");
    if (it.status === "none") out.push("对方声明：没有。", "");
    else if (it.files.length === 0) out.push("未交。", "");
    else out.push(...table(it.files));
  }
  if (m.unassigned.length)
    out.push(`## 未分类（${m.unassigned.length} 个）`, "", ...table(m.unassigned));
  const u = m.usage;
  out.push(
    "## 费用（这一轮）",
    "",
    `$${u.usd.toFixed(4)} · 归类 ${u.calls.sort} 次 · 描述 ${u.calls.describe} 次 · 转写 ${u.calls.transcribe} 次${u.skipped.budget ? ` · 因上限跳过 ${u.skipped.budget} 次` : ""}`,
    "",
  );
  return out.join("\n");
};
