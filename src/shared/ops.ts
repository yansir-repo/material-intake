/**
 * 操作表（docs/format.md §2.2）：封闭集合。agent 只能挑选操作、填参数。
 * 每个操作的参数范围、默认值、在哪里跑、读什么、给对方看的说法、「丢了什么」的句子，都只在这里。
 */
import type { AcceptKind, Kind } from "./kinds.ts";

export const OP_NAMES = [
  "image.resize",
  "image.tile",
  "video.frames",
  "pdf.markdown",
  "pdf.pages",
  "doc.markdown",
  "slides.text",
  "text.keep",
  "describe",
  "transcribe",
  "file.keep",
] as const;
export type OpName = (typeof OP_NAMES)[number];

/** exact = 不丢信息；lossy = 确定地丢信息（`lost` 写明）；model = 模型产出，不保证可复现。 */
export type OpClass = "exact" | "lossy" | "model";
/**
 * 在哪里跑、读什么：
 * - browser：对方浏览器里做，上传产物；
 * - transit：原件过境服务端做（toMarkdown），转完即弃；
 * - audio：浏览器把音轨解码重采样，分段送服务端（Whisper），录音不保存；
 * - products：服务端读已存的产物做（describe 读图片产物）；
 * - original：原件上传保存（file.keep，提交时）。
 */
export type OpInput = "browser" | "transit" | "audio" | "products" | "original";

type IntSpec = {
  readonly type: "int";
  readonly min: number;
  readonly max: number;
  readonly default?: number;
};
type NumSpec = {
  readonly type: "number";
  readonly min: number;
  readonly max: number;
  readonly default?: number;
};
type EnumSpec = {
  readonly type: "enum";
  readonly values: ReadonlyArray<string>;
  readonly default?: string;
};
type BoolSpec = { readonly type: "bool"; readonly default?: boolean };
type StrSpec = {
  readonly type: "string";
  readonly maxLength: number;
  readonly required?: boolean;
  readonly default?: string;
};
export type ParamSpec = IntSpec | NumSpec | EnumSpec | BoolSpec | StrSpec;

export type Params = Readonly<Record<string, string | number | boolean>>;

export type OpDef = {
  readonly name: OpName;
  readonly accepts: ReadonlyArray<AcceptKind>;
  readonly input: OpInput;
  readonly cls: OpClass;
  readonly params: Readonly<Record<string, ParamSpec>>;
  /** 给对方看的一句话（说做什么，不给模型产出的内容）。 */
  readonly say: (p: Params) => string;
  readonly describe: string;
};

const IMAGE_FORMAT: EnumSpec = { type: "enum", values: ["webp", "jpeg", "png"], default: "webp" };
const QUALITY: NumSpec = { type: "number", min: 0.5, max: 0.95, default: 0.82 };
const LONG_EDGE = (d: number): IntSpec => ({ type: "int", min: 256, max: 4096, default: d });

export const DESCRIBE_MODEL = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
export const TRANSCRIBE_MODEL = "@cf/openai/whisper-large-v3-turbo";
/** 一段送去转写的音频最长多少秒（docs/format.md §2.2）。 */
export const TRANSCRIBE_SEGMENT_SECONDS = 30 * 60;
/** 视觉产物最多读几张（clef、describe 一次最多 4 张图）。 */
export const MAX_VISUALS = 4;

export const OPS: Readonly<Record<OpName, OpDef>> = {
  "image.resize": {
    name: "image.resize",
    accepts: ["image"],
    input: "browser",
    cls: "lossy",
    params: { longEdge: LONG_EDGE(1600), format: IMAGE_FORMAT, quality: QUALITY },
    say: (p) => `缩到长边 ${String(p["longEdge"])}px`,
    describe: "Downscale to a long edge, re-encode (EXIF removed). One image.",
  },
  "image.tile": {
    name: "image.tile",
    accepts: ["image"],
    input: "browser",
    cls: "lossy",
    params: {
      tile: { type: "int", min: 512, max: 2048, default: 1024 },
      overlap: { type: "int", min: 0, max: 256, default: 64 },
      format: IMAGE_FORMAT,
      quality: QUALITY,
    },
    say: (p) => `切成 ${String(p["tile"])}px 小块，保留原分辨率`,
    describe:
      "Cut into full-resolution tiles with overlap (for small text). Equals image.resize when the long edge ≤ tile.",
  },
  "video.frames": {
    name: "video.frames",
    accepts: ["video"],
    input: "browser",
    cls: "lossy",
    params: {
      count: { type: "int", min: 2, max: 48, default: 8 },
      longEdge: LONG_EDGE(960),
      sheet: { type: "bool", default: true },
      cols: { type: "int", min: 1, max: 6, default: 4 },
    },
    say: (p) => `抽 ${String(p["count"])} 帧，原片不上传`,
    describe: "Evenly spaced frames (with timestamps) and, if sheet, one contact sheet.",
  },
  "pdf.markdown": {
    name: "pdf.markdown",
    accepts: ["pdf"],
    input: "transit",
    cls: "lossy",
    params: {},
    say: () => "取出文字",
    describe: "Text layer as Markdown via Workers AI toMarkdown (scans come out nearly empty).",
  },
  "pdf.pages": {
    name: "pdf.pages",
    accepts: ["pdf"],
    input: "browser",
    cls: "lossy",
    params: {
      maxPages: { type: "int", min: 1, max: 200, default: 30 },
      longEdge: LONG_EDGE(1600),
      format: IMAGE_FORMAT,
    },
    say: () => "每页渲染成图",
    describe: "Render each page (up to maxPages) as an image.",
  },
  "doc.markdown": {
    name: "doc.markdown",
    accepts: ["doc", "sheet"],
    input: "transit",
    cls: "lossy",
    params: {},
    say: () => "转成文字和表格",
    describe: "Markdown via Workers AI toMarkdown (CSV is read as UTF-8 by us).",
  },
  "slides.text": {
    name: "slides.text",
    accepts: ["slides"],
    input: "browser",
    cls: "lossy",
    params: {},
    say: () => "取出每页文字",
    describe: "Text boxes and speaker notes per slide, as Markdown.",
  },
  "text.keep": {
    name: "text.keep",
    accepts: ["text"],
    input: "browser",
    cls: "exact",
    params: { maxBytes: { type: "int", min: 1024, max: 1_048_576, default: 1_048_576 } },
    say: () => "原样保留",
    describe: "The text as is.",
  },
  describe: {
    name: "describe",
    accepts: ["image", "video", "pdf"],
    input: "products",
    cls: "model",
    params: {
      model: { type: "enum", values: [DESCRIBE_MODEL], default: DESCRIBE_MODEL },
      prompt: { type: "string", maxLength: 2000, required: true },
      maxTokens: { type: "int", min: 64, max: 2048, default: 400 },
      reasoning: { type: "enum", values: ["none", "low"], default: "none" },
    },
    say: () => "",
    describe:
      "A vision model writes text about the image products earlier in the same pipeline (max 4). Never shown to the respondent.",
  },
  transcribe: {
    name: "transcribe",
    accepts: ["audio", "video"],
    input: "audio",
    cls: "model",
    params: {
      model: { type: "enum", values: [TRANSCRIBE_MODEL], default: TRANSCRIBE_MODEL },
      language: { type: "string", maxLength: 8, default: "" },
      prompt: { type: "string", maxLength: 500, default: "" },
      vad: { type: "bool", default: true },
    },
    say: () => "录音转成文字，录音本身不上传",
    describe: `Speech to text (Whisper) in segments of ≤ ${TRANSCRIBE_SEGMENT_SECONDS / 60} min; not applicable to a video without sound.`,
  },
  "file.keep": {
    name: "file.keep",
    accepts: ["image", "video", "pdf", "sheet", "doc", "slides", "text", "audio", "any"],
    input: "original",
    cls: "exact",
    params: { maxBytes: { type: "int", min: 1024, max: 5 * 1024 ** 3, default: 200 * 1024 ** 2 } },
    say: () => "上传原件（提交时）",
    describe:
      "Store the original as is. Only in an item's pipeline; uploaded when the round is submitted.",
  },
};

export const isOpName = (x: unknown): x is OpName =>
  typeof x === "string" && (OP_NAMES as ReadonlyArray<string>).includes(x);

export type Step = { readonly op: OpName; readonly params: Params };

/** 一个步骤的参数：按 spec 补默认值、逐个核对范围。返回展开后的参数或逐条问题。 */
export const resolveParams = (
  op: OpName,
  given: Readonly<Record<string, unknown>>,
):
  | { readonly ok: true; readonly params: Params }
  | { readonly ok: false; readonly problems: ReadonlyArray<string> } => {
  const def = OPS[op];
  const problems: string[] = [];
  const out: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(given))
    if (!(key in def.params)) problems.push(`${op}: unknown parameter ${key}`);
  for (const [key, spec] of Object.entries(def.params)) {
    const v = given[key] ?? spec.default;
    if (v === undefined) {
      if (spec.type === "string" && spec.required) problems.push(`${op}: ${key} is required`);
      continue;
    }
    switch (spec.type) {
      case "int":
      case "number":
        if (
          typeof v !== "number" ||
          !Number.isFinite(v) ||
          (spec.type === "int" && !Number.isInteger(v)) ||
          v < spec.min ||
          v > spec.max
        )
          problems.push(
            `${op}: ${key} must be ${spec.type === "int" ? "an integer" : "a number"} in ${spec.min}–${spec.max}`,
          );
        else out[key] = v;
        break;
      case "enum":
        if (typeof v !== "string" || !spec.values.includes(v))
          problems.push(`${op}: ${key} must be one of ${spec.values.join(", ")}`);
        else out[key] = v;
        break;
      case "bool":
        if (typeof v !== "boolean") problems.push(`${op}: ${key} must be true or false`);
        else out[key] = v;
        break;
      case "string":
        if (typeof v !== "string" || v.length > spec.maxLength)
          problems.push(`${op}: ${key} must be text of at most ${spec.maxLength} characters`);
        else if (spec.required && v.trim() === "") problems.push(`${op}: ${key} is required`);
        else out[key] = v;
        break;
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true, params: out };
};

/** 产物的键：同一邀请内 (sha256, op, params) 唯一决定一个产物（§2.1）。参数按键排序后序列化，所以写法不同不影响。 */
export const canonicalParams = (p: Params): string =>
  JSON.stringify(
    Object.fromEntries(Object.entries(p).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );

/** 一个操作是否产出图片（describe 读它们、clef 看它们）。 */
export const producesImages = (op: OpName): boolean =>
  op === "image.resize" || op === "image.tile" || op === "video.frames" || op === "pdf.pages";
export const producesText = (op: OpName): boolean =>
  op === "pdf.markdown" ||
  op === "doc.markdown" ||
  op === "slides.text" ||
  op === "text.keep" ||
  op === "transcribe";

export const acceptsKind = (op: OpName, kind: AcceptKind): boolean =>
  OPS[op].accepts.includes(kind);
export type { Kind };
