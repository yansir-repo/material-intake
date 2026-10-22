/**
 * 一个文件、它的产物，以及「它现在处理到哪一步」——全部由存下来的事实推出来，不另存状态（docs/format.md §2.3、§6）。
 * worker 和对方页面用同一份推导。
 */
import type { AcceptKind } from "./kinds.ts";
import type { SourceFacts, ProductMeta } from "./facts.ts";
import { OPS, type OpName, type Params, type Step } from "./ops.ts";
import type { Assignment } from "./sort.ts";
import { pipelineFor, type Snapshot } from "./template.ts";

export type ProductStatus = "done" | "skipped" | "partial";

/** 一个产物：(sha256, op, params) 唯一决定。图片在 R2，文字在 `text`。 */
export type Product = {
  readonly op: OpName;
  readonly params: Params;
  /** `<op>.<参数哈希前 8 位>`：在地址和输出路径里代表这一步。 */
  readonly stepId: string;
  readonly status: ProductStatus;
  readonly reason?: string;
  readonly meta: ProductMeta & {
    readonly files?: ReadonlyArray<string>;
    readonly segmentsDone?: number;
    readonly segmentsTotal?: number;
  };
  readonly text?: string;
  readonly lost?: string;
  /** model 类：模型名、实际读了哪些产物。 */
  readonly model?: string;
  readonly reads?: ReadonlyArray<string>;
  readonly segments?: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
    readonly text: string;
  }>;
};

export type FileRecord = {
  readonly id: string;
  readonly round: number;
  readonly name: string;
  readonly path: string;
  readonly kind: AcceptKind;
  readonly mime: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly facts: SourceFacts;
  readonly assignment: Assignment | null;
  /** 对方能修的失败（§2.3）：文件本身的问题。 */
  readonly failure: { readonly op: string; readonly reason: string } | null;
  readonly duplicateOf: string | null;
};

export type StepState = {
  readonly op: OpName;
  readonly params: Params;
  readonly stepId: string;
  readonly product: Product | undefined;
};

export const stepsOf = (
  snap: Snapshot,
  f: Pick<FileRecord, "assignment" | "kind">,
  products: ReadonlyMap<string, Product>,
  stepIdOf: (s: Step) => string,
): ReadonlyArray<StepState> =>
  pipelineFor(snap, f.assignment?.item ?? null, f.kind).map((s) => {
    const stepId = stepIdOf(s);
    return { op: s.op, params: s.params, stepId, product: products.get(stepId) };
  });

/** 一步有没有「做过」：done、或者 skipped（不适用 / 我们这边的原因）都算；partial 不算。 */
export const settled = (s: StepState): boolean =>
  s.product !== undefined && s.product.status !== "partial";

/**
 * 文件现在的状态（推出来的）：
 * - failed：对方能修的失败；
 * - processing：还有浏览器端 / 过境 / 转写步骤没做完，或者还没归类（总区里的文件）；
 * - ready：其余。model 类的 describe 可以之后由服务端补；file.keep 在提交时上传，不算处理中。
 */
export type FileState = "failed" | "processing" | "ready";
export const fileState = (f: FileRecord, steps: ReadonlyArray<StepState>): FileState => {
  if (f.failure) return "failed";
  if (f.assignment === null) return "processing";
  const pending = steps.filter((s) => {
    const input = OPS[s.op].input;
    return (input === "browser" || input === "transit" || input === "audio") && !settled(s);
  });
  return pending.length ? "processing" : "ready";
};

/** 提交时还缺的原件（file.keep 的步骤没有 done 的产物）。 */
export const missingOriginal = (steps: ReadonlyArray<StepState>): boolean =>
  steps.some((s) => s.op === "file.keep" && s.product?.status !== "done");
