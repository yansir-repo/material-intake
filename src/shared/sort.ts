/**
 * 归类（docs/format.md §3）：选项 = 这次邀请里收这个类型的收集项 + none。引擎不自带任何类别。
 * 这里只有纯的两半：怎么问（clef 的请求），怎么落（按阈值决定归属）。调用模型在 worker/models.ts。
 */
import type { AcceptKind } from "./kinds.ts";
import { KIND_LABEL } from "./kinds.ts";
import type { Snapshot } from "./template.ts";

export const NONE = "none";
export const SORT_QUESTION_ID = "item";

export type ChoiceQuestion = {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
};

/** 收这个类型的项（候选）。 */
export const candidatesFor = (snap: Snapshot, kind: AcceptKind): ReadonlyArray<string> =>
  snap.items.filter((i) => i.accept.includes(kind)).map((i) => i.key);

export const sortQuestion = (snap: Snapshot, kind: AcceptKind): ChoiceQuestion => {
  const criteria: Record<string, string> = {};
  for (const it of snap.items.filter((i) => i.accept.includes(kind)))
    criteria[it.key] = [it.title, it.ask, it.sortHint].filter((x) => x !== "").join("。");
  criteria[NONE] = "以上都不是";
  return {
    type: "choice",
    instructions:
      "对方把一个文件交了上来。它属于下面哪一项？只根据看到、听到、读到的内容和文件路径判断；都不像就选「以上都不是」。",
    criteria,
  };
};

/** 给 clef 的 state：路径（对方自己的文件夹名常常就是答案）、类型、文字开头、模板的领域说明。 */
export const sortState = (
  snap: Snapshot,
  file: { readonly path: string; readonly kind: AcceptKind; readonly text?: string },
): Readonly<Record<string, unknown>> => ({
  ...(snap.sort.instructions ? { context: snap.sort.instructions } : {}),
  file: { path: file.path, type: KIND_LABEL[file.kind] },
  ...(file.text ? { text: file.text.slice(0, snap.sort.textChars) } : {}),
});

export type Assignment =
  | {
      readonly item: string;
      readonly by: "client";
      readonly scores?: Readonly<Record<string, number>>;
    }
  | {
      readonly item: string;
      readonly by: "model";
      readonly model: string;
      readonly p: number;
      readonly scores: Readonly<Record<string, number>>;
    }
  | {
      readonly item: null;
      readonly by: "none";
      readonly model?: string;
      readonly p?: number;
      readonly scores?: Readonly<Record<string, number>>;
      /** 没有分数时为什么（budget / model-error / no-content）。 */
      readonly reason?: string;
      /** 给对方的两个候选（按分数）。 */
      readonly candidates: ReadonlyArray<string>;
    };

/** 按阈值决定（§3.2）：最高分 ≥ 阈值且不是 none 才落位，否则未分类并给出两个候选。 */
export const decide = (
  snap: Snapshot,
  kind: AcceptKind,
  model: string,
  scores: Readonly<Record<string, number>>,
): Assignment => {
  const allowed = new Set(candidatesFor(snap, kind));
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [top, p] = ranked[0] ?? [NONE, 0];
  if (top !== NONE && allowed.has(top) && p >= snap.sort.threshold)
    return { item: top, by: "model", model, p, scores };
  const candidates = ranked
    .filter(([k]) => k !== NONE && allowed.has(k))
    .slice(0, 2)
    .map(([k]) => k);
  return { item: null, by: "none", model, p, scores, candidates };
};

/** 模型没给分数时（预算、出错、没有可看的内容）：未分类，候选按清单顺序。 */
export const unsorted = (snap: Snapshot, kind: AcceptKind, reason: string): Assignment => ({
  item: null,
  by: "none",
  reason,
  candidates: candidatesFor(snap, kind).slice(0, 2),
});
