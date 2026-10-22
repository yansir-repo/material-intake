/**
 * 文件类型（docs/format.md §1）：由**文件头**判定，扩展名只作核对；两者矛盾就拒收。
 * 这是唯一一处懂文件格式的地方——浏览器在放进来那一刻调它，服务端在字节过境时（转换、存原件）再调一次。
 */

export const KINDS = ["image", "video", "pdf", "sheet", "doc", "slides", "text", "audio"] as const;
export type Kind = (typeof KINDS)[number];
/** `any`：只在打开了 file.keep 的项里出现，收任何类型的原件。 */
export type AcceptKind = Kind | "any";
export const ACCEPT_KINDS: ReadonlyArray<AcceptKind> = [...KINDS, "any"];

export const KIND_LABEL: Readonly<Record<AcceptKind, string>> = {
  image: "图片",
  video: "视频",
  pdf: "PDF",
  sheet: "表格",
  doc: "文档",
  slides: "演示文稿",
  text: "文本",
  audio: "录音",
  any: "其他文件",
};

/** 扩展名 → 类型 + 规范 MIME。只有在这里的扩展名才是「我们认识的」。 */
const EXT: Readonly<Record<string, { readonly kind: Kind; readonly mime: string }>> = {
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  png: { kind: "image", mime: "image/png" },
  webp: { kind: "image", mime: "image/webp" },
  gif: { kind: "image", mime: "image/gif" },
  heic: { kind: "image", mime: "image/heic" },
  heif: { kind: "image", mime: "image/heif" },
  avif: { kind: "image", mime: "image/avif" },
  bmp: { kind: "image", mime: "image/bmp" },
  tif: { kind: "image", mime: "image/tiff" },
  tiff: { kind: "image", mime: "image/tiff" },
  mp4: { kind: "video", mime: "video/mp4" },
  m4v: { kind: "video", mime: "video/mp4" },
  mov: { kind: "video", mime: "video/quicktime" },
  webm: { kind: "video", mime: "video/webm" },
  mkv: { kind: "video", mime: "video/x-matroska" },
  avi: { kind: "video", mime: "video/x-msvideo" },
  pdf: { kind: "pdf", mime: "application/pdf" },
  xlsx: {
    kind: "sheet",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  xlsm: { kind: "sheet", mime: "application/vnd.ms-excel.sheet.macroenabled.12" },
  xlsb: { kind: "sheet", mime: "application/vnd.ms-excel.sheet.binary.macroenabled.12" },
  xls: { kind: "sheet", mime: "application/vnd.ms-excel" },
  et: { kind: "sheet", mime: "application/vnd.ms-excel" },
  ods: { kind: "sheet", mime: "application/vnd.oasis.opendocument.spreadsheet" },
  numbers: { kind: "sheet", mime: "application/vnd.apple.numbers" },
  csv: { kind: "sheet", mime: "text/csv" },
  docx: {
    kind: "doc",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  odt: { kind: "doc", mime: "application/vnd.oasis.opendocument.text" },
  html: { kind: "doc", mime: "text/html" },
  htm: { kind: "doc", mime: "text/html" },
  xml: { kind: "doc", mime: "application/xml" },
  pptx: {
    kind: "slides",
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
  txt: { kind: "text", mime: "text/plain" },
  md: { kind: "text", mime: "text/markdown" },
  json: { kind: "text", mime: "application/json" },
  yaml: { kind: "text", mime: "application/yaml" },
  yml: { kind: "text", mime: "application/yaml" },
  m4a: { kind: "audio", mime: "audio/mp4" },
  mp3: { kind: "audio", mime: "audio/mpeg" },
  wav: { kind: "audio", mime: "audio/wav" },
  aac: { kind: "audio", mime: "audio/aac" },
  ogg: { kind: "audio", mime: "audio/ogg" },
  oga: { kind: "audio", mime: "audio/ogg" },
  flac: { kind: "audio", mime: "audio/flac" },
  amr: { kind: "audio", mime: "audio/amr" },
};

/** 认识但不收的，给对方一句能照着做的话。 */
const KNOWN_REFUSALS: Readonly<Record<string, string>> = {
  doc: "老版 .doc 打不开。请另存为 .docx 或 PDF 再放进来。",
  ppt: "老版 .ppt 打不开。请另存为 .pptx 或 PDF 再放进来。",
  rtf: ".rtf 打不开。请另存为 .docx 或 PDF 再放进来。",
  key: "Keynote 文件打不开。请导出为 PDF 或 .pptx 再放进来。",
  pages: "Pages 文件打不开。请导出为 PDF 或 .docx 再放进来。",
  zip: "不收压缩包。请解压后把里面的文件放进来。",
  rar: "不收压缩包。请解压后把里面的文件放进来。",
  "7z": "不收压缩包。请解压后把里面的文件放进来。",
};

/** 系统文件：静默忽略，只计数。 */
export const isSystemFile = (path: string): boolean => {
  const parts = path.split("/");
  const name = (parts.at(-1) ?? "").toLowerCase();
  return (
    name === ".ds_store" ||
    name === "thumbs.db" ||
    name === "desktop.ini" ||
    name.startsWith("._") ||
    parts.some((p) => p === "__MACOSX" || p === ".Spotlight-V100" || p === ".Trashes")
  );
};

export const extOf = (name: string): string => {
  const base = name.split("/").at(-1) ?? name;
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i + 1).toLowerCase();
};

/** 判定一个文件需要读的开头字节数。 */
export const HEAD_BYTES = 4096;

type Container =
  | "jpeg"
  | "png"
  | "gif"
  | "webp"
  | "bmp"
  | "tiff"
  | "isobmff-image"
  | "isobmff-video"
  | "isobmff-audio"
  | "ebml"
  | "avi"
  | "wav"
  | "pdf"
  | "zip"
  | "ole"
  | "mp3"
  | "aac"
  | "ogg"
  | "flac"
  | "amr"
  | "text"
  | "unknown";

const ascii = (b: Uint8Array, at: number, len: number): string =>
  String.fromCharCode(...b.subarray(at, at + len));
const starts = (b: Uint8Array, bytes: ReadonlyArray<number>, at = 0): boolean =>
  bytes.every((x, i) => b[at + i] === x);

const ISO_IMAGE = new Set([
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevx",
  "mif1",
  "msf1",
  "avif",
  "avis",
]);
const ISO_AUDIO = new Set(["M4A ", "M4B ", "M4P ", "F4A "]);

/** 文件头 → 容器。 */
export const containerOf = (b: Uint8Array): Container => {
  if (starts(b, [0xff, 0xd8, 0xff])) return "jpeg";
  if (starts(b, [0x89, 0x50, 0x4e, 0x47])) return "png";
  if (ascii(b, 0, 4) === "GIF8") return "gif";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "AVI ") return "avi";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WAVE") return "wav";
  if (ascii(b, 0, 2) === "BM") return "bmp";
  if (starts(b, [0x49, 0x49, 0x2a, 0x00]) || starts(b, [0x4d, 0x4d, 0x00, 0x2a])) return "tiff";
  if (ascii(b, 4, 4) === "ftyp") {
    const major = ascii(b, 8, 4);
    if (ISO_AUDIO.has(major)) return "isobmff-audio";
    if (ISO_IMAGE.has(major)) return "isobmff-image";
    return "isobmff-video";
  }
  if (starts(b, [0x1a, 0x45, 0xdf, 0xa3])) return "ebml";
  if (ascii(b, 0, 5) === "%PDF-") return "pdf";
  if (starts(b, [0x50, 0x4b, 0x03, 0x04]) || starts(b, [0x50, 0x4b, 0x05, 0x06])) return "zip";
  if (starts(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole";
  if (ascii(b, 0, 3) === "ID3") return "mp3";
  if (b[0] === 0xff && b[1] !== undefined && (b[1] & 0xf6) === 0xf0) return "aac";
  if (b[0] === 0xff && b[1] !== undefined && (b[1] & 0xe0) === 0xe0) return "mp3";
  if (ascii(b, 0, 4) === "OggS") return "ogg";
  if (ascii(b, 0, 4) === "fLaC") return "flac";
  if (ascii(b, 0, 5) === "#!AMR") return "amr";
  return utf8(b) ? "text" : "unknown";
};

/** 开头这一段能否按 UTF-8 解码（结尾被截断的多字节字符不算错）。 */
const utf8 = (b: Uint8Array): boolean => {
  if (b.length === 0) return true;
  if (b.includes(0)) return false;
  let end = b.length;
  // 去掉末尾可能被截断的多字节序列
  for (let back = 1; back <= 3 && end - back >= 0; back++) {
    const c = b[end - back]!;
    if ((c & 0xc0) === 0xc0) {
      end -= back;
      break;
    }
    if ((c & 0x80) === 0) break;
  }
  // 非严格解码会把非法字节换成 U+FFFD：出现它就不是 UTF-8 文本
  return !new TextDecoder("utf-8").decode(b.subarray(0, end)).includes("\uFFFD");
};

/** 每个扩展名期望的容器。zip/ole 是好几种格式共用的壳，靠扩展名区分里面是什么。 */
const CONTAINER_OF_EXT: Readonly<Record<string, ReadonlyArray<Container>>> = {
  jpg: ["jpeg"],
  jpeg: ["jpeg"],
  png: ["png"],
  webp: ["webp"],
  gif: ["gif"],
  bmp: ["bmp"],
  tif: ["tiff"],
  tiff: ["tiff"],
  heic: ["isobmff-image"],
  heif: ["isobmff-image"],
  avif: ["isobmff-image"],
  mp4: ["isobmff-video"],
  m4v: ["isobmff-video"],
  mov: ["isobmff-video"],
  webm: ["ebml"],
  mkv: ["ebml"],
  avi: ["avi"],
  pdf: ["pdf"],
  xlsx: ["zip"],
  xlsm: ["zip"],
  xlsb: ["zip"],
  ods: ["zip"],
  numbers: ["zip"],
  docx: ["zip"],
  odt: ["zip"],
  pptx: ["zip"],
  xls: ["ole"],
  et: ["ole"],
  csv: ["text"],
  html: ["text"],
  htm: ["text"],
  xml: ["text"],
  txt: ["text"],
  md: ["text"],
  json: ["text"],
  yaml: ["text"],
  yml: ["text"],
  m4a: ["isobmff-audio", "isobmff-video"],
  mp3: ["mp3"],
  wav: ["wav"],
  aac: ["aac"],
  ogg: ["ogg"],
  oga: ["ogg"],
  flac: ["flac"],
  amr: ["amr"],
};

const CONTAINER_LABEL: Readonly<Partial<Record<Container, string>>> = {
  jpeg: "JPEG 图片",
  png: "PNG 图片",
  gif: "GIF 图片",
  webp: "WebP 图片",
  bmp: "BMP 图片",
  tiff: "TIFF 图片",
  "isobmff-image": "HEIC/AVIF 图片",
  "isobmff-video": "视频",
  "isobmff-audio": "录音",
  ebml: "视频",
  avi: "视频",
  wav: "录音",
  pdf: "PDF",
  zip: "zip 压缩包",
  ole: "老版 Office 文件",
  mp3: "录音",
  aac: "录音",
  ogg: "录音",
  flac: "录音",
  amr: "录音",
  text: "纯文本",
};

export type Sniffed =
  | { readonly ok: true; readonly kind: Kind; readonly mime: string }
  | { readonly ok: true; readonly kind: "any"; readonly mime: string }
  | { readonly ok: false; readonly reason: string };

/**
 * 判定一个文件。`allowAny` = 这一次放进来的地方收任何原件（项开了 file.keep 且 accept 有 any）：
 * 不认识的格式这时候不拒，按 `any` 收。
 */
export const sniff = (name: string, head: Uint8Array, allowAny = false): Sniffed => {
  const ext = extOf(name);
  const known = EXT[ext];
  const container = containerOf(head);
  if (!known) {
    if (allowAny) return { ok: true, kind: "any", mime: "application/octet-stream" };
    return {
      ok: false,
      reason: KNOWN_REFUSALS[ext] ?? `这种文件（${ext ? `.${ext}` : "没有扩展名"}）收不了。`,
    };
  }
  const expected = CONTAINER_OF_EXT[ext] ?? [];
  if (!expected.includes(container)) {
    if (allowAny) return { ok: true, kind: "any", mime: "application/octet-stream" };
    const actual = CONTAINER_LABEL[container];
    return {
      ok: false,
      reason: actual
        ? `扩展名是 .${ext}，内容却是${actual}。${container === "zip" ? "请解压后放里面的文件。" : "请确认文件没有改过扩展名。"}`
        : `扩展名是 .${ext}，但内容对不上，可能已损坏。`,
    };
  }
  return { ok: true, kind: known.kind, mime: known.mime };
};
