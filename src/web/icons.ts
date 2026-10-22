/**
 * 没有图片产物的文件用的图标：经典的「折角文件 + 彩色标签」，颜色按大家熟悉的那一套（PDF 红、Word 蓝、表格绿、演示橙…）。
 * 内联 SVG，不依赖外部图标库。
 */
import { extOf, type AcceptKind } from "../shared/kinds.ts";

type Look = {
  readonly color: string;
  readonly label: string;
  readonly glyph?: "wave" | "lines" | "grid" | "slide" | "play" | "picture";
};

const lookOf = (kind: AcceptKind, name: string): Look => {
  const ext = extOf(name);
  if (kind === "pdf") return { color: "#d93025", label: "PDF", glyph: "lines" };
  if (kind === "sheet")
    return {
      color: "#1e7145",
      label: ext === "csv" ? "CSV" : ext === "numbers" ? "NUM" : "XLS",
      glyph: "grid",
    };
  if (kind === "slides") return { color: "#c4441c", label: "PPT", glyph: "slide" };
  if (kind === "doc")
    return ext === "html" || ext === "htm" || ext === "xml"
      ? { color: "#5f6b7a", label: ext.toUpperCase(), glyph: "lines" }
      : { color: "#2b5797", label: "DOC", glyph: "lines" };
  if (kind === "text")
    return { color: "#6b7280", label: (ext || "TXT").toUpperCase().slice(0, 4), glyph: "lines" };
  if (kind === "audio")
    return { color: "#7c3aed", label: (ext || "AUDIO").toUpperCase().slice(0, 4), glyph: "wave" };
  if (kind === "video")
    return { color: "#334155", label: (ext || "VIDEO").toUpperCase().slice(0, 4), glyph: "play" };
  if (kind === "image")
    return { color: "#0e7490", label: (ext || "IMG").toUpperCase().slice(0, 4), glyph: "picture" };
  return { color: "#475569", label: (ext || "FILE").toUpperCase().slice(0, 4) };
};

const glyphOf = (g: Look["glyph"], c: string): string => {
  switch (g) {
    case "lines":
      return [14, 19, 24, 29]
        .map(
          (y, i) =>
            `<rect x="10" y="${y}" width="${i === 3 ? 12 : 20}" height="2" rx="1" fill="${c}" opacity=".35"/>`,
        )
        .join("");
    case "grid":
      return `<g stroke="${c}" stroke-opacity=".45" stroke-width="1.4" fill="none"><rect x="9" y="13" width="22" height="16" rx="1.5"/><path d="M9 18.5h22M9 24h22M16.5 13v16M24 13v16"/></g>`;
    case "slide":
      return `<rect x="9" y="13" width="22" height="14" rx="1.5" fill="none" stroke="${c}" stroke-opacity=".5" stroke-width="1.4"/><rect x="12" y="17" width="8" height="2" rx="1" fill="${c}" opacity=".45"/><rect x="12" y="21" width="13" height="2" rx="1" fill="${c}" opacity=".3"/>`;
    case "wave":
      return `<path d="M9 21h2l1.5-5 2 10 2-14 2 16 2-12 2 8 1.5-4H31" fill="none" stroke="${c}" stroke-opacity=".6" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
    case "play":
      return `<circle cx="20" cy="21" r="7.5" fill="${c}" opacity=".15"/><path d="M18 17.5v7l6-3.5z" fill="${c}" opacity=".7"/>`;
    case "picture":
      return `<rect x="9" y="13" width="22" height="16" rx="1.5" fill="none" stroke="${c}" stroke-opacity=".45" stroke-width="1.4"/><circle cx="15" cy="18" r="2" fill="${c}" opacity=".45"/><path d="M10 28l7-6 4 3 4-4 6 7" fill="none" stroke="${c}" stroke-opacity=".5" stroke-width="1.4"/>`;
    default:
      return "";
  }
};

/** 一个文件图标（宽高随容器）。 */
export const fileIcon = (kind: AcceptKind, name: string): string => {
  const l = lookOf(kind, name);
  return `<svg class="ficon" viewBox="0 0 40 48" aria-hidden="true">
    <path d="M6 2h20l10 10v32a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="#fff" stroke="#d9d0bf"/>
    <path d="M26 2v8a2 2 0 0 0 2 2h8" fill="#f3eee4" stroke="#d9d0bf"/>
    ${glyphOf(l.glyph, l.color)}
    <rect x="4" y="33" width="${Math.max(18, l.label.length * 6 + 8)}" height="10" rx="1.5" fill="${l.color}"/>
    <text x="${4 + Math.max(18, l.label.length * 6 + 8) / 2}" y="40.6" text-anchor="middle" font-family="IBM Plex Mono, ui-monospace, monospace" font-size="7" font-weight="600" fill="#fff">${l.label}</text>
  </svg>`;
};
