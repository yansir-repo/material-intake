/**
 * 关于字节的事实（原件的规格）与产物的规格，以及由它们**确定地**算出的「丢了什么」（docs/format.md §2.2、§8.1）。
 * `lost` 不是模型写的：同样的原件规格 + 操作 + 参数 + 产物规格，永远是同一句话。
 */
import type { OpName, Params } from "./ops.ts";

/** 原件的事实。width/height：图片、视频；duration：视频、录音；pages：PDF；slides：演示文稿。 */
export type SourceFacts = {
  readonly width?: number;
  readonly height?: number;
  readonly duration?: number;
  readonly hasAudio?: boolean;
  readonly pages?: number;
  readonly slides?: number;
};

/** 产物的规格（浏览器或服务端做完后报告的）。 */
export type ProductMeta = {
  readonly mime?: string;
  readonly bytes?: number;
  readonly width?: number;
  readonly height?: number;
  /** 图片实际编码成的格式（浏览器不支持所请求的格式时会不同）。 */
  readonly format?: string;
  readonly tiles?: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  }>;
  readonly cols?: number;
  readonly rows?: number;
  readonly frames?: ReadonlyArray<number>;
  readonly sheet?: boolean;
  readonly pages?: number;
  readonly chars?: number;
  readonly segments?: number;
};

/** 按长边缩放后的尺寸（浏览器和说明用同一个算法）。 */
export const fitLongEdge = (
  w: number,
  h: number,
  longEdge: number,
): { readonly w: number; readonly h: number } => {
  const k = Math.min(1, longEdge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
};

/** 切块的网格：每块 tile×tile（边缘可能更小），相邻两块重叠 overlap。 */
export const tileGrid = (
  w: number,
  h: number,
  tile: number,
  overlap: number,
): ReadonlyArray<{
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}> => {
  if (Math.max(w, h) <= tile) return [{ x: 0, y: 0, w, h }];
  const step = tile - overlap;
  const starts = (len: number): number[] => {
    if (len <= tile) return [0];
    const out: number[] = [];
    for (let s = 0; s + tile < len; s += step) out.push(s);
    out.push(len - tile);
    return out;
  };
  return starts(h).flatMap((y) =>
    starts(w).map((x) => ({ x, y, w: Math.min(tile, w - x), h: Math.min(tile, h - y) })),
  );
};

/** 视频抽帧的时间点：均匀分布在 [0, duration)，最后一帧离结尾留一点余量（解码器在结尾常常给不出画面）。 */
export const frameTimes = (duration: number, count: number): ReadonlyArray<number> => {
  const end = Math.max(0, duration - Math.min(0.5, duration / 20));
  if (count <= 1 || end === 0) return [0];
  return Array.from({ length: count }, (_, i) => Math.round(((end * i) / (count - 1)) * 10) / 10);
};

const secs = (s: number): string => `${Math.round(s * 10) / 10} 秒`;

/** 「丢了什么」。exact 与 model 类操作没有这句话。 */
export const lostOf = (
  op: OpName,
  p: Params,
  src: SourceFacts,
  out: ProductMeta,
): string | undefined => {
  switch (op) {
    case "image.resize": {
      const fmt = String(out.format ?? p["format"]).toUpperCase();
      const changed = src.width !== undefined && out.width !== undefined && out.width < src.width;
      return changed
        ? `分辨率 ${src.width}×${src.height} → ${out.width}×${out.height}；重新编码为 ${fmt}；EXIF 已去除`
        : `尺寸未变；重新编码为 ${fmt}；EXIF 已去除`;
    }
    case "image.tile": {
      const n = out.tiles?.length ?? 0;
      return n <= 1
        ? `尺寸未超过 ${String(p["tile"])}px，未切块；重新编码；EXIF 已去除`
        : `按 ${String(p["tile"])}px 切成 ${out.cols}×${out.rows} 块（重叠 ${String(p["overlap"])}px），每块是原分辨率；EXIF 已去除`;
    }
    case "video.frames": {
      const n = out.frames?.length ?? 0;
      const sound = src.hasAudio ? "；声音不在这个产物里" : "";
      return `${secs(src.duration ?? 0)}的视频只保留 ${n} 帧（${out.width}×${out.height}）${sound}`;
    }
    case "pdf.markdown":
      return (out.chars ?? 0) < 40 * Math.max(1, src.pages ?? 1)
        ? "文字层几乎为空（可能是扫描件），文字只在页面图里"
        : "版式与图片丢失，只保留文字与表格";
    case "pdf.pages": {
      const n = out.pages ?? 0;
      return `${n}/${src.pages ?? n} 页渲染为长边 ${String(p["longEdge"])}px 的图`;
    }
    case "doc.markdown":
      return "版式、图片、公式与格式丢失，只保留文字与表格（表格只保留单元格的值）";
    case "slides.text":
      return `${src.slides ?? "?"} 页的版式和图片丢失，只保留文字框与备注`;
    case "text.keep":
    case "describe":
    case "transcribe":
    case "file.keep":
      return undefined;
  }
};
