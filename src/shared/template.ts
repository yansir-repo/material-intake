/**
 * 模板 + 覆盖 → 邀请快照（docs/format.md §4、§5）。合成之后先校验，不通过就不生成链接，返回逐条原因。
 * 快照里的处理链参数全部展开；之后改模板不影响已经发出的邀请。
 */
import { ACCEPT_KINDS, KINDS, type AcceptKind, type Kind } from "./kinds.ts";
import { OPS, isOpName, producesImages, resolveParams, type OpName, type Step } from "./ops.ts";

export const SORT_MODEL = "@cf/cloudflare/clef-flash";
export const SORT_AUDIO_MODEL = "@cf/cloudflare/clef-omni";

// ---- 输入（模板与覆盖都是这个形状的数据） ------------------------------------------------------

export type StepInput = { readonly op: string } & Readonly<Record<string, unknown>>;
export type PipelineInput = Readonly<Partial<Record<string, ReadonlyArray<StepInput>>>>;
export type ItemInput = {
  readonly key: string;
  readonly title?: string;
  readonly ask?: string;
  readonly sortHint?: string;
  readonly accept?: ReadonlyArray<string>;
  readonly pipeline?: PipelineInput;
  readonly count?: { readonly min?: number; readonly max?: number };
  readonly required?: boolean;
  readonly allowNone?: boolean;
  readonly note?: string;
  /** 只在覆盖里：删掉这一项。 */
  readonly remove?: boolean;
};
export type TemplateInput = {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly requester: string;
  readonly intro?: string;
  readonly defaults?: {
    readonly expiresInDays?: number;
    readonly rounds?: string;
    readonly maxFiles?: number;
    readonly retainDays?: number;
  };
  readonly pipeline: PipelineInput;
  readonly sort?: {
    readonly threshold?: number;
    readonly textChars?: number;
    readonly instructions?: string;
  };
  readonly items: ReadonlyArray<ItemInput>;
};
export type Overrides = {
  readonly title?: string;
  readonly requester?: string;
  readonly intro?: string;
  readonly items?: ReadonlyArray<ItemInput>;
  readonly pipeline?: PipelineInput;
  readonly sort?: {
    readonly threshold?: number;
    readonly textChars?: number;
    readonly instructions?: string;
  };
  readonly expiresInDays?: number;
  readonly rounds?: string;
  readonly maxFiles?: number;
  readonly retainDays?: number;
  /** 不给 = 不设上限。 */
  readonly budget?: { readonly usd: number } | null;
};

// ---- 快照 ---------------------------------------------------------------------------------------

export type Item = {
  readonly key: string;
  readonly title: string;
  readonly ask: string;
  readonly sortHint: string;
  readonly accept: ReadonlyArray<AcceptKind>;
  /** 只有这一项覆盖的类型；其余类型用邀请级默认（pipelineFor）。 */
  readonly pipeline: Readonly<Partial<Record<AcceptKind, ReadonlyArray<Step>>>>;
  readonly count: { readonly min: number; readonly max: number };
  readonly required: boolean;
  readonly allowNone: boolean;
  readonly note: "off" | "optional" | "required";
};
export type Snapshot = {
  readonly template: { readonly id: string; readonly version: number };
  readonly title: string;
  readonly requester: string;
  readonly intro: string;
  readonly rounds: "one" | "many";
  readonly maxFiles: number;
  readonly retainDays: number;
  readonly expiresInDays: number;
  readonly budget: { readonly usd: number } | null;
  readonly pipeline: Readonly<Partial<Record<Kind, ReadonlyArray<Step>>>>;
  readonly sort: {
    readonly model: string;
    readonly audioModel: string;
    readonly threshold: number;
    readonly textChars: number;
    readonly instructions: string;
  };
  readonly items: ReadonlyArray<Item>;
};

export type Resolved =
  | { readonly ok: true; readonly snapshot: Snapshot }
  | { readonly ok: false; readonly problems: ReadonlyArray<string> };

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const isAcceptKind = (x: unknown): x is AcceptKind =>
  typeof x === "string" && (ACCEPT_KINDS as ReadonlyArray<string>).includes(x);
const isKind = (x: unknown): x is Kind =>
  typeof x === "string" && (KINDS as ReadonlyArray<string>).includes(x);

const intIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const numIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

/** 一条处理链：每步展开参数；file.keep 只在项里；describe 前面要有图片产物；any 只能 file.keep。 */
const resolveSteps = (
  where: string,
  kind: AcceptKind,
  steps: ReadonlyArray<StepInput>,
  inItem: boolean,
  problems: string[],
): ReadonlyArray<Step> => {
  const out: Step[] = [];
  if (!Array.isArray(steps) || steps.length === 0) {
    problems.push(`${where}.${kind}: the pipeline is empty`);
    return out;
  }
  for (const s of steps) {
    const { op, ...given } = s ?? { op: "" };
    if (!isOpName(op)) {
      problems.push(`${where}.${kind}: unknown op ${String(op)}`);
      continue;
    }
    if (!OPS[op].accepts.includes(kind))
      problems.push(`${where}.${kind}: ${op} does not accept ${kind}`);
    if (op === "file.keep" && !inItem)
      problems.push(`${where}.${kind}: file.keep only in an item's pipeline`);
    if (kind === "any" && op !== "file.keep") problems.push(`${where}.any: only file.keep`);
    if (op === "describe" && !out.some((x) => producesImages(x.op)))
      problems.push(`${where}.${kind}: describe needs an image-producing step before it`);
    const r = resolveParams(op, given);
    if (!r.ok) problems.push(...r.problems.map((p) => `${where}.${kind}: ${p}`));
    else out.push({ op, params: r.params });
  }
  return out;
};

const resolvePipeline = (
  where: string,
  input: PipelineInput | undefined,
  inItem: boolean,
  problems: string[],
): Partial<Record<AcceptKind, ReadonlyArray<Step>>> => {
  const out: Partial<Record<AcceptKind, ReadonlyArray<Step>>> = {};
  for (const [kind, steps] of Object.entries(input ?? {})) {
    if (!isAcceptKind(kind) || (!inItem && !isKind(kind))) {
      problems.push(`${where}: unknown kind ${kind}`);
      continue;
    }
    out[kind] = resolveSteps(where, kind, steps ?? [], inItem, problems);
  }
  return out;
};

/** 覆盖里的项：同 key 浅合并（pipeline 按类型替换），`remove: true` 删掉，新 key 追加。 */
const mergeItems = (
  base: ReadonlyArray<ItemInput>,
  over: ReadonlyArray<ItemInput> | undefined,
): ReadonlyArray<ItemInput> => {
  if (!over) return base;
  let items = [...base];
  for (const o of over) {
    const i = items.findIndex((x) => x.key === o.key);
    if (o.remove) items = items.filter((x) => x.key !== o.key);
    else if (i < 0) items.push(o);
    else {
      const cur = items[i]!;
      items[i] = { ...cur, ...o, pipeline: { ...cur.pipeline, ...o.pipeline } };
    }
  }
  return items;
};

export const resolve = (tpl: TemplateInput, ov: Overrides = {}): Resolved => {
  const problems: string[] = [];
  const title = (ov.title ?? tpl.title ?? "").trim();
  const requester = (ov.requester ?? tpl.requester ?? "").trim();
  const intro = (ov.intro ?? tpl.intro ?? "").trim();
  if (!title || title.length > 60) problems.push("title: 1–60 characters");
  if (!requester || requester.length > 40) problems.push("requester: 1–40 characters");
  if (intro.length > 1000) problems.push("intro: at most 1000 characters");

  const d = tpl.defaults ?? {};
  const rounds = ov.rounds ?? d.rounds ?? "many";
  if (rounds !== "one" && rounds !== "many") problems.push("rounds: one | many");
  const maxFiles = ov.maxFiles ?? d.maxFiles ?? 500;
  if (!intIn(maxFiles, 1, 5000)) problems.push("maxFiles: an integer in 1–5000");
  const retainDays = ov.retainDays ?? d.retainDays ?? 30;
  if (!intIn(retainDays, 1, 365)) problems.push("retainDays: an integer in 1–365");
  const expiresInDays = ov.expiresInDays ?? d.expiresInDays ?? 14;
  if (!intIn(expiresInDays, 1, 365)) problems.push("expiresInDays: an integer in 1–365");
  const budget = ov.budget ?? null;
  if (budget !== null && !numIn(budget.usd, 0.0001, 10_000))
    problems.push("budget.usd: a number in 0.0001–10000 (or omit for no cap)");

  const pipeline = resolvePipeline(
    "pipeline",
    { ...tpl.pipeline, ...ov.pipeline },
    false,
    problems,
  ) as Partial<Record<Kind, ReadonlyArray<Step>>>;

  const s = { ...tpl.sort, ...ov.sort };
  const threshold = s.threshold ?? 0.7;
  if (!numIn(threshold, 0.5, 0.99)) problems.push("sort.threshold: a number in 0.5–0.99");
  const textChars = s.textChars ?? 2000;
  if (!intIn(textChars, 200, 8000)) problems.push("sort.textChars: an integer in 200–8000");
  const instructions = (s.instructions ?? "").trim();
  if (instructions.length > 1000) problems.push("sort.instructions: at most 1000 characters");

  const inputs = mergeItems(tpl.items ?? [], ov.items);
  if (inputs.length === 0) problems.push("items: at least one");
  if (inputs.length > 60) problems.push("items: at most 60");
  const seen = new Set<string>();
  const items: Item[] = [];
  for (const it of inputs) {
    const where = `items.${it.key}`;
    if (!KEY_RE.test(it.key ?? "")) problems.push(`${where}: key must match ${KEY_RE.source}`);
    if (seen.has(it.key)) problems.push(`${where}: duplicate key`);
    seen.add(it.key);
    const t = (it.title ?? "").trim();
    if (!t || t.length > 40) problems.push(`${where}.title: 1–40 characters`);
    const ask = (it.ask ?? "").trim();
    if (ask.length > 500) problems.push(`${where}.ask: at most 500 characters`);
    const accept = (it.accept ?? []).filter(isAcceptKind);
    if (accept.length === 0 || accept.length !== (it.accept ?? []).length)
      problems.push(`${where}.accept: a non-empty list of ${ACCEPT_KINDS.join(", ")}`);
    const own = resolvePipeline(where, it.pipeline, true, problems);
    for (const k of Object.keys(own))
      if (!accept.includes(k as AcceptKind)) problems.push(`${where}.pipeline.${k}: not in accept`);
    for (const k of accept) {
      if (k === "any" && !own.any)
        problems.push(`${where}: accepting any needs pipeline.any with file.keep`);
      else if (k !== "any" && !own[k] && !pipeline[k])
        problems.push(`${where}: no pipeline for ${k} (neither the item's nor the default)`);
    }
    const min = it.count?.min ?? (it.required ? 1 : 0);
    const max = it.count?.max ?? 200;
    if (!intIn(min, 0, 1000) || !intIn(max, 1, 1000) || min > max)
      problems.push(`${where}.count: 0 ≤ min ≤ max ≤ 1000`);
    const required = it.required ?? false;
    if (required && min < 1) problems.push(`${where}: required needs count.min ≥ 1`);
    const note = it.note ?? "optional";
    if (note !== "off" && note !== "optional" && note !== "required")
      problems.push(`${where}.note: off | optional | required`);
    const sortHint = (it.sortHint ?? "").trim();
    if (sortHint.length > 300) problems.push(`${where}.sortHint: at most 300 characters`);
    items.push({
      key: it.key,
      title: t,
      ask,
      sortHint,
      accept,
      pipeline: own,
      count: { min, max },
      required,
      allowNone: it.allowNone ?? false,
      note: note as Item["note"],
    });
  }

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    snapshot: {
      template: { id: tpl.id, version: tpl.version },
      title,
      requester,
      intro,
      rounds: rounds as "one" | "many",
      maxFiles,
      retainDays,
      expiresInDays,
      budget,
      pipeline,
      sort: { model: SORT_MODEL, audioModel: SORT_AUDIO_MODEL, threshold, textChars, instructions },
      items,
    },
  };
};

/** 一个文件最终的处理链：它所属那一项对它的类型的处理链；项里没写就用邀请级默认；未分类用默认。 */
export const pipelineFor = (
  snap: Snapshot,
  itemKey: string | null,
  kind: AcceptKind,
): ReadonlyArray<Step> => {
  const item = itemKey === null ? undefined : snap.items.find((i) => i.key === itemKey);
  return item?.pipeline[kind] ?? (kind === "any" ? [] : (snap.pipeline[kind] ?? []));
};

export const itemAccepts = (snap: Snapshot, itemKey: string, kind: AcceptKind): boolean =>
  snap.items.find((i) => i.key === itemKey)?.accept.includes(kind) ?? false;

/** 这个类型在这次邀请里有没有地方收（总区里放进来的文件先过这一关）。 */
export const acceptedAnywhere = (snap: Snapshot, kind: AcceptKind): boolean =>
  snap.items.some((i) => i.accept.includes(kind));

export const usesOp = (snap: Snapshot, op: OpName): boolean =>
  Object.values(snap.pipeline).some((s) => s?.some((x) => x.op === op)) ||
  snap.items.some((it) => Object.values(it.pipeline).some((s) => s?.some((x) => x.op === op)));

/** 打开了 file.keep 的项（对方页面上的承诺由它推出来）。 */
export const keepItems = (snap: Snapshot): ReadonlyArray<Item> =>
  snap.items.filter((it) =>
    Object.values(it.pipeline).some((s) => s?.some((x) => x.op === "file.keep")),
  );
