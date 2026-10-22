/**
 * 浏览器端的操作（docs/format.md §2.2 里 input = browser / audio 的那些）和关于字节的事实。
 * 参数、尺寸算法、切块网格、抽帧时间点都来自 shared/（和服务端、说明用同一份），这里只做解码和编码。
 * 失败分两种（§2.3）：`Fixable` 是文件本身的问题，对方换个文件能修；其余是我们这边的问题。
 */
import { strFromU8, unzipSync } from "fflate";
import type { Libheif } from "libheif-js/libheif-wasm/libheif-bundle.mjs";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  fitLongEdge,
  frameTimes,
  tileGrid,
  type ProductMeta,
  type SourceFacts,
} from "../shared/facts.ts";
import { HEAD_BYTES, sniff, type AcceptKind } from "../shared/kinds.ts";
import { boxAt, moovFacts, type MoovFacts } from "../shared/media.ts";
import type { Params } from "../shared/ops.ts";
import { Sha256 } from "../shared/sha256.ts";

/** pdf.js 按需加载（只有放进 PDF 时才下载）。 */
let pdfjsLib: Promise<typeof import("pdfjs-dist")> | null = null;
const pdfjs = () =>
  (pdfjsLib ??= import("pdfjs-dist").then((m) => {
    m.GlobalWorkerOptions.workerSrc = pdfWorker;
    return m;
  }));

/** 文件本身的问题：对方能修（换格式、换文件）。 */
export class Fixable extends Error {}

export type Output = {
  readonly meta: ProductMeta;
  readonly files: ReadonlyArray<{ readonly name: string; readonly blob: Blob }>;
  readonly text?: string;
};

// ---- 识别与事实 ----------------------------------------------------------------------------------

export const sniffFile = async (file: File, path: string, allowAny: boolean) =>
  sniff(path, new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer()), allowAny);

/** 完整 sha256，分块喂（几百 MB 的视频也不整个读进内存）。 */
export const hashFile = async (
  file: File,
  onProgress?: (done: number) => void,
): Promise<string> => {
  const h = new Sha256();
  const CHUNK = 8 * 1024 * 1024;
  for (let at = 0; at < file.size; at += CHUNK) {
    h.update(new Uint8Array(await file.slice(at, at + CHUNK).arrayBuffer()));
    onProgress?.(Math.min(file.size, at + CHUNK));
  }
  return h.hex();
};

const once = (el: HTMLMediaElement, event: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const ok = () => {
      el.removeEventListener("error", bad);
      resolve();
    };
    const bad = () => {
      el.removeEventListener(event, ok);
      reject(
        new Fixable(
          "这个浏览器解不了这个文件的编码。可以在手机或电脑上「导出为兼容格式」（H.264 / AAC）后重新放进来。",
        ),
      );
    };
    el.addEventListener(event, ok, { once: true });
    el.addEventListener("error", bad, { once: true });
  });

const openVideo = async (file: File): Promise<HTMLVideoElement> => {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  v.src = URL.createObjectURL(file);
  await once(v, "loadedmetadata");
  if (!v.videoWidth || !Number.isFinite(v.duration))
    throw new Fixable("读不出这个视频的画面。可以导出为 MP4（H.264）后重新放进来。");
  return v;
};

/**
 * HEIC / HEIF：只有 Safari 能直接解。其他浏览器按需加载 libheif（wasm，约 2 MB，只加载一次），解出主图交给同一条缩图/切块。
 * libheif 解码时按文件里的 irot / imir 转正。一张 4800 万像素的图解出来要 ~200 MB，所以同时只解一张（heifLock）。
 */
let libheif: Promise<Libheif> | null = null;
let heifLock: Promise<unknown> = Promise.resolve();
const decodeHeif = (file: File): Promise<ImageBitmap> => {
  const run = async (): Promise<ImageBitmap> => {
    libheif ??= import("libheif-js/libheif-wasm/libheif-bundle.mjs").then((m) => m.default());
    const lib = await libheif;
    const images = new lib.HeifDecoder().decode(new Uint8Array(await file.arrayBuffer()));
    try {
      const img = images.find((i) => i.is_primary()) ?? images[0];
      if (!img) throw new Error("no image");
      const data = new ImageData(img.get_width(), img.get_height());
      await new Promise<void>((ok, bad) =>
        img.display(data, (out) => (out ? ok() : bad(new Error("display")))),
      );
      return await createImageBitmap(data);
    } finally {
      images.forEach((i) => i.free());
    }
  };
  const next = heifLock.then(run, run);
  heifLock = next.catch(() => undefined);
  return next;
};

const decodeImage = async (file: File): Promise<ImageBitmap> => {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    if (ext === "heic" || ext === "heif") {
      try {
        return await decodeHeif(file);
      } catch {
        throw new Fixable("这张 HEIC 照片解不开，可能已损坏。请换一张，或导出为 JPEG 再放进来。");
      }
    }
    throw new Fixable(
      ext === "tif" || ext === "tiff"
        ? "这个浏览器解不了 TIFF 图片。请用 Safari 打开本页，或另存为 JPEG / PNG 再放进来。"
        : "这张图片打不开，可能已损坏。请换一张。",
    );
  }
};

/** 打开 PDF；用完调 close（释放 worker 里的文档）。 */
const openPdf = async (file: File) => {
  const task = (await pdfjs()).getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  try {
    const doc = await task.promise;
    return { doc, close: () => task.destroy() };
  } catch {
    void task.destroy();
    throw new Fixable("这个 PDF 打不开（可能加了密码或已损坏）。请换一份。");
  }
};

/** 读 MP4 / M4A / MOV 的 moov（只读各个顶层 box 的头，再读 moov 本身）。不是这种容器、或 moov 太大：null。 */
export const readMoov = async (file: File): Promise<MoovFacts | null> => {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (String.fromCharCode(...head.subarray(4, 8)) !== "ftyp") return null;
  for (let at = 0, guard = 0; at < file.size && guard < 64; guard++) {
    const h = boxAt(new Uint8Array(await file.slice(at, at + 16).arrayBuffer()), 0, file.size - at);
    if (!h || h.size < h.headerSize) return null;
    if (h.type === "moov")
      return h.size > 64 * 1024 * 1024
        ? null
        : moovFacts(new Uint8Array(await file.slice(at, at + h.size).arrayBuffer()));
    at += h.size;
  }
  return null;
};

const slideEntries = (zip: Record<string, Uint8Array>): string[] =>
  Object.keys(zip)
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));

/** 关于字节的事实：尺寸、时长、页数、有没有声音（拿不准就不写）。 */
export const factsOf = async (file: File, kind: AcceptKind): Promise<SourceFacts> => {
  switch (kind) {
    case "image": {
      const b = await decodeImage(file);
      const f = { width: b.width, height: b.height };
      b.close();
      return f;
    }
    case "video": {
      // 时长和有没有声音以容器里写的为准（浏览器的元数据在它解不了的编码上会静默地错）
      const moov = await readMoov(file);
      const v = await openVideo(file);
      const f: SourceFacts = {
        width: v.videoWidth,
        height: v.videoHeight,
        duration: moov?.duration ?? Math.round(v.duration * 10) / 10,
        ...(moov ? { hasAudio: moov.hasAudio } : {}),
      };
      URL.revokeObjectURL(v.src);
      return f;
    }
    case "audio": {
      const moov = await readMoov(file);
      if (moov?.duration) return { duration: moov.duration };
      const a = document.createElement("audio");
      a.preload = "metadata";
      a.src = URL.createObjectURL(file);
      try {
        await once(a, "loadedmetadata");
        return Number.isFinite(a.duration) ? { duration: Math.round(a.duration * 10) / 10 } : {};
      } catch {
        return {};
      } finally {
        URL.revokeObjectURL(a.src);
      }
    }
    case "pdf": {
      const { doc, close } = await openPdf(file);
      const pages = doc.numPages;
      await close();
      return { pages };
    }
    case "slides": {
      try {
        return {
          slides: slideEntries(
            unzipSync(new Uint8Array(await file.arrayBuffer()), {
              filter: (f) => /^ppt\/slides\/slide\d+\.xml$/.test(f.name),
            }),
          ).length,
        };
      } catch {
        throw new Fixable("这个 .pptx 打不开，可能已损坏。请另存一次或导出为 PDF。");
      }
    }
    default:
      return {};
  }
};

// ---- 图片编码 -------------------------------------------------------------------------------------

const EXT: Readonly<Record<string, string>> = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
};

/**
 * 按请求的格式编码。失败模型：Safari 的 canvas 不会编 WebP，静默给出 PNG。这时改编 JPEG，并在产物里记下实际格式
 * （meta.format），「丢了什么」照实写。移除条件：所有目标浏览器都能编 WebP。
 */
const encode = async (
  canvas: OffscreenCanvas,
  format: string,
  quality: number,
): Promise<{ blob: Blob; format: string }> => {
  const type = `image/${format}`;
  const blob = await canvas.convertToBlob({ type, quality });
  if (blob.type === type) return { blob, format };
  return { blob: await canvas.convertToBlob({ type: "image/jpeg", quality }), format: "jpeg" };
};

const draw = (
  src: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  w: number,
  h: number,
) => {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  g.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  return c;
};

// ---- 操作 ----------------------------------------------------------------------------------------

const num = (p: Params, k: string) => Number(p[k]);

export const runBrowserOp = async (op: string, p: Params, file: File): Promise<Output> => {
  switch (op) {
    case "image.resize": {
      const b = await decodeImage(file);
      const { w, h } = fitLongEdge(b.width, b.height, num(p, "longEdge"));
      const { blob, format } = await encode(
        draw(b, 0, 0, b.width, b.height, w, h),
        String(p["format"]),
        num(p, "quality"),
      );
      b.close();
      return {
        meta: { width: w, height: h, format, mime: blob.type },
        files: [{ name: `image.${EXT[blob.type]}`, blob }],
      };
    }
    case "image.tile": {
      const b = await decodeImage(file);
      const grid = tileGrid(b.width, b.height, num(p, "tile"), num(p, "overlap"));
      const files: { name: string; blob: Blob }[] = [];
      let fmt = String(p["format"]);
      for (const [i, t] of grid.entries()) {
        const { blob, format } = await encode(
          draw(b, t.x, t.y, t.w, t.h, t.w, t.h),
          String(p["format"]),
          num(p, "quality"),
        );
        fmt = format;
        files.push({ name: `t${String(i).padStart(3, "0")}.${EXT[blob.type]}`, blob });
      }
      const cols = new Set(grid.map((t) => t.x)).size;
      b.close();
      return {
        meta: {
          tiles: grid,
          cols,
          rows: grid.length / cols,
          format: fmt,
          width: b.width,
          height: b.height,
        },
        files,
      };
    }
    case "video.frames": {
      const v = await openVideo(file);
      const { w, h } = fitLongEdge(v.videoWidth, v.videoHeight, num(p, "longEdge"));
      const times = frameTimes(v.duration, num(p, "count"));
      const frames: OffscreenCanvas[] = [];
      for (const t of times) {
        v.currentTime = t;
        await once(v, "seeked");
        frames.push(draw(v, 0, 0, v.videoWidth, v.videoHeight, w, h));
      }
      URL.revokeObjectURL(v.src);
      const files: { name: string; blob: Blob }[] = [];
      for (const [i, c] of frames.entries()) {
        const { blob } = await encode(c, "webp", 0.8);
        files.push({ name: `f${String(i).padStart(2, "0")}.${EXT[blob.type]}`, blob });
      }
      if (p["sheet"] === true) {
        const cols = Math.min(num(p, "cols"), frames.length);
        const rows = Math.ceil(frames.length / cols);
        const cw = Math.min(w, Math.round(1920 / cols));
        const ch = Math.round((cw * h) / w);
        const sheet = new OffscreenCanvas(cw * cols, ch * rows);
        const g = sheet.getContext("2d")!;
        g.fillStyle = "#111";
        g.fillRect(0, 0, sheet.width, sheet.height);
        g.font = `${Math.max(12, Math.round(ch / 12))}px sans-serif`;
        frames.forEach((c, i) => {
          const x = (i % cols) * cw,
            y = Math.floor(i / cols) * ch;
          g.drawImage(c, x, y, cw, ch);
          const t = times[i]!;
          g.fillStyle = "rgba(0,0,0,.6)";
          g.fillRect(
            x + 4,
            y + ch - Math.round(ch / 8) - 4,
            Math.round(cw / 4),
            Math.round(ch / 8),
          );
          g.fillStyle = "#fff";
          g.fillText(
            `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`,
            x + 8,
            y + ch - 10,
          );
        });
        const { blob } = await encode(sheet, "webp", 0.8);
        files.push({ name: `sheet.${EXT[blob.type]}`, blob });
      }
      return { meta: { frames: times, sheet: p["sheet"] === true, width: w, height: h }, files };
    }
    case "pdf.pages": {
      const { doc, close } = await openPdf(file);
      const n = Math.min(doc.numPages, num(p, "maxPages"));
      const files: { name: string; blob: Blob }[] = [];
      let fmt = String(p["format"]);
      for (let i = 1; i <= n; i++) {
        const page = await doc.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const scale = num(p, "longEdge") / Math.max(base.width, base.height);
        const vp = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        await page.render({ canvas, viewport: vp }).promise;
        const off = new OffscreenCanvas(canvas.width, canvas.height);
        off.getContext("2d")!.drawImage(canvas, 0, 0);
        const { blob, format } = await encode(off, String(p["format"]), 0.85);
        fmt = format;
        files.push({ name: `p${String(i).padStart(3, "0")}.${EXT[blob.type]}`, blob });
      }
      await close();
      return { meta: { pages: n, format: fmt }, files };
    }
    case "slides.text": {
      let zip: Record<string, Uint8Array>;
      try {
        zip = unzipSync(new Uint8Array(await file.arrayBuffer()));
      } catch {
        throw new Fixable("这个 .pptx 打不开，可能已损坏。请另存一次或导出为 PDF。");
      }
      const texts = (xml: string): string[] => {
        const doc = new DOMParser().parseFromString(xml, "application/xml");
        return [...doc.getElementsByTagNameNS("*", "p")]
          .map((para) =>
            [...para.getElementsByTagNameNS("*", "t")].map((t) => t.textContent ?? "").join(""),
          )
          .filter((s) => s.trim() !== "");
      };
      const out: string[] = [];
      for (const [i, entry] of slideEntries(zip).entries()) {
        out.push(`## 第 ${i + 1} 页`, "", ...texts(strFromU8(zip[entry]!)), "");
        const rels = zip[entry.replace("slides/", "slides/_rels/") + ".rels"];
        const target = rels
          ? /Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/.exec(strFromU8(rels))?.[1]
          : undefined;
        const notes = target ? zip[`ppt/notesSlides/${target}`] : undefined;
        // 备注页里第一段通常是页码占位，去掉纯数字
        const lines = notes ? texts(strFromU8(notes)).filter((s) => !/^\d+$/.test(s.trim())) : [];
        if (lines.length) out.push(`> 备注：${lines.join(" / ")}`, "");
      }
      return { meta: {}, files: [], text: out.join("\n") };
    }
    case "text.keep": {
      if (file.size > num(p, "maxBytes"))
        throw new Fixable(
          `文本文件超过 ${Math.round(num(p, "maxBytes") / 1024)} KB，请拆成几份再放进来。`,
        );
      return { meta: {}, files: [], text: await file.text() };
    }
  }
  throw new Error(`not a browser op: ${op}`);
};
