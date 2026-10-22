/**
 * 对方页面看到的东西（GET /i/<id>.<key>/api/state）。页面上所有因用途而变的文字来自快照；
 * 隐私承诺由快照**推出来**（docs/format.md §6），不写死。引擎自己的文字中性，不含领域词。
 */
import { KIND_LABEL, type AcceptKind } from "./kinds.ts";
import type { ProductMeta, SourceFacts } from "./facts.ts";
import { OPS, type OpInput, type OpName, type Params } from "./ops.ts";
import type { Assignment } from "./sort.ts";
import { keepItems, pipelineFor, usesOp, type Snapshot } from "./template.ts";
import type { FileState, ProductStatus } from "./model.ts";

export const promises = (snap: Snapshot): ReadonlyArray<string> => {
  const keep = keepItems(snap);
  const out = [
    keep.length
      ? `「${keep.map((i) => i.title).join("」「")}」会上传原件，其余只上传处理后的版本`
      : "原件留在您的电脑上，只上传处理后的版本",
  ];
  if (usesOp(snap, "pdf.markdown") || usesOp(snap, "doc.markdown"))
    out.push("文档经服务器转成文字，转完原件立刻删除");
  if (usesOp(snap, "transcribe")) out.push("录音转成文字，录音本身不上传");
  out.push("这个链接只能交，不能查看已经交过的资料");
  return out;
};

/** 一项里每种类型会怎么处理（给对方看；model 类的 describe 没有说法，不显示）。 */
export const howOf = (
  snap: Snapshot,
  itemKey: string,
): ReadonlyArray<{
  readonly kind: AcceptKind;
  readonly label: string;
  readonly says: ReadonlyArray<string>;
}> => {
  const it = snap.items.find((i) => i.key === itemKey);
  if (!it) return [];
  return it.accept.map((kind) => ({
    kind,
    label: KIND_LABEL[kind],
    says: pipelineFor(snap, itemKey, kind)
      .map((s) => OPS[s.op].say(s.params))
      .filter((x) => x !== ""),
  }));
};

export type PageItem = {
  readonly key: string;
  readonly title: string;
  readonly ask: string;
  readonly accept: ReadonlyArray<AcceptKind>;
  readonly required: boolean;
  readonly allowNone: boolean;
  readonly note: "off" | "optional" | "required";
  readonly count: { readonly min: number; readonly max: number };
  readonly how: ReturnType<typeof howOf>;
};

/** 对方页面上一个步骤：要做什么、做到哪了。model 类的产出内容不给对方（只给状态）。 */
export type PageStep = {
  readonly stepId: string;
  readonly op: OpName;
  readonly params: Params;
  readonly input: OpInput;
  readonly say: string;
  readonly status: ProductStatus | "missing";
  readonly meta?: ProductMeta & {
    readonly files?: ReadonlyArray<string>;
    readonly segmentsDone?: number;
    readonly segmentsTotal?: number;
  };
  readonly text?: string;
  readonly lost?: string;
};

export type PageFile = {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly kind: AcceptKind;
  readonly bytes: number;
  readonly sha256: string;
  readonly facts: SourceFacts;
  readonly assignment: Assignment | null;
  readonly failure: { readonly op: string; readonly reason: string } | null;
  readonly state: FileState;
  readonly steps: ReadonlyArray<PageStep>;
};

export type PageView = {
  readonly id: string;
  readonly title: string;
  readonly requester: string;
  readonly intro: string;
  readonly expiresAt: string;
  readonly open: boolean;
  readonly closedReason: "" | "closed" | "expired" | "revoked";
  readonly round: number;
  readonly rounds: "one" | "many";
  readonly promises: ReadonlyArray<string>;
  readonly items: ReadonlyArray<PageItem>;
  /** 有没有项收任何原件（总区里不认识的格式也收）。 */
  readonly acceptAny: boolean;
  readonly files: ReadonlyArray<PageFile>;
  readonly notes: Readonly<Record<string, { readonly none: boolean; readonly note: string }>>;
  /** 已提交的轮次：只有文件名和数量（链接只能交、不能看）。 */
  readonly earlier: ReadonlyArray<{
    readonly round: number;
    readonly submittedAt: string;
    readonly items: ReadonlyArray<{
      readonly title: string;
      readonly status: string;
      readonly note?: string;
      readonly names: ReadonlyArray<string>;
    }>;
    readonly unassigned: ReadonlyArray<string>;
  }>;
  readonly limits: { readonly maxFiles: number; readonly transitBytes: number };
};

/** 服务端过境转换（toMarkdown）一次请求的上限：Worker 请求体 100 MB，留点余量。 */
export const TRANSIT_MAX_BYTES = 95 * 1024 * 1024;
/** file.keep 分片上传的每片大小（R2 要求除最后一片外 ≥ 5 MiB）。 */
export const ORIGINAL_PART_BYTES = 16 * 1024 * 1024;
/** 归类时给 clef-omni 听的录音片段上限（它的限制是 300 秒、8 MiB；16 kHz 单声道 16 位 240 秒 ≈ 7.7 MB）。 */
export const SORT_AUDIO_SECONDS = 240;
export const AUDIO_RATE = 16_000;
