/**
 * 模型调用的价钱（docs/format.md §3.4）。金额一律用整数「纳美元」（1e-9 USD）记，求和不丢精度。
 * 估价 = 最坏情况（预留用）；结算 = 按返回的实际用量（没有用量信息就按估价，宁多不少）。
 * 单价来自 Workers AI 的模型页（2026-10-22 核对）。
 */

export const NANO = 1_000_000_000;
export const toNano = (usd: number): number => Math.round(usd * NANO);
export const toUsd = (nano: number): number => nano / NANO;

/** 每个 token 的纳美元。 */
export const PRICE = {
  clefFlashIn: 38, // $0.038 / M
  clefOmniIn: 150, // $0.15 / M
  deepseekIn: 300, // $0.30 / M
  deepseekOut: 1200, // $1.20 / M
  whisperPerMinute: 513_000, // $0.000513 / 分钟
} as const;

/** clef 一张图最多 1024 个 token + 3 个标记。 */
const CLEF_IMAGE_TOKENS = 1027;
/** clef-omni 的音频：约 780 token / 分钟。 */
const OMNI_AUDIO_TOKENS_PER_SECOND = 13;
/** 问题与 state 的结构开销。 */
const CLEF_OVERHEAD_TOKENS = 600;
/** DeepSeek 的图片 token 没有公开上限：按一张 1600 估（宁多不少），结算时用返回的实际值。 */
const DEEPSEEK_IMAGE_TOKENS = 1600;
/** 中文大约一字一 token，英文更少；按字符数估是上界。 */
const textTokens = (chars: number): number => chars;

export type ModelUse = "sort" | "describe" | "transcribe";

export const estimateSort = (
  images: number,
  textChars: number,
  criteriaChars: number,
  audioSeconds = 0,
): number =>
  audioSeconds > 0
    ? (Math.ceil(audioSeconds * OMNI_AUDIO_TOKENS_PER_SECOND) +
        textTokens(textChars + criteriaChars) +
        CLEF_OVERHEAD_TOKENS) *
      PRICE.clefOmniIn
    : (images * CLEF_IMAGE_TOKENS + textTokens(textChars + criteriaChars) + CLEF_OVERHEAD_TOKENS) *
      PRICE.clefFlashIn;

export const settleSort = (inputTokens: number, audio: boolean): number =>
  inputTokens * (audio ? PRICE.clefOmniIn : PRICE.clefFlashIn);

export const estimateDescribe = (images: number, promptChars: number, maxTokens: number): number =>
  (images * DEEPSEEK_IMAGE_TOKENS + textTokens(promptChars) + 200) * PRICE.deepseekIn +
  maxTokens * PRICE.deepseekOut;

export const settleDescribe = (promptTokens: number, completionTokens: number): number =>
  promptTokens * PRICE.deepseekIn + completionTokens * PRICE.deepseekOut;

/** Whisper 按分钟计；每段向上取整到整分钟作估价。 */
export const estimateTranscribe = (seconds: number): number =>
  Math.ceil(seconds / 60) * PRICE.whisperPerMinute;
export const settleTranscribe = (seconds: number): number =>
  Math.ceil((seconds / 60) * PRICE.whisperPerMinute);

/** 预留的规则（worker 用一条带条件的 INSERT 原子地执行它）：没有上限，或 已花 + 已预留 + 这次 ≤ 上限。 */
export const fits = (
  capNano: number | null,
  committedNano: number,
  estimateNano: number,
): boolean => capNano === null || committedNano + estimateNano <= capNano;
