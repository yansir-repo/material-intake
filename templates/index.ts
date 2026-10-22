/**
 * 模板：引擎里**唯一**允许懂领域的地方（src/shared/independence.test.ts 守着这一条）。
 * 一个模板 = 要收的项、每种文件怎么处理、怎么分。改它只影响之后建的邀请；已发出的邀请用的是建时的快照。
 */
import type { TemplateInput } from "../src/shared/template.ts";

const DEFAULT_PIPELINE: TemplateInput["pipeline"] = {
  image: [{ op: "image.resize" }],
  video: [
    { op: "video.frames", count: 12 },
    { op: "transcribe", language: "zh" },
  ],
  pdf: [{ op: "pdf.markdown" }, { op: "pdf.pages" }],
  doc: [{ op: "doc.markdown" }],
  sheet: [{ op: "doc.markdown" }],
  slides: [{ op: "slides.text" }],
  text: [{ op: "text.keep" }],
  audio: [{ op: "transcribe", language: "zh" }],
};

export const TEMPLATES: Readonly<Record<string, TemplateInput>> = {
  blank: {
    id: "blank",
    version: 1,
    title: "资料",
    requester: "我们",
    intro: "把手上的资料整个文件夹拖进来就行。",
    pipeline: DEFAULT_PIPELINE,
    items: [
      {
        key: "files",
        title: "资料",
        ask: "",
        accept: ["image", "video", "pdf", "doc", "sheet", "slides", "text", "audio"],
        required: true,
      },
    ],
  },
  "website-kickoff": {
    id: "website-kickoff",
    version: 1,
    title: "建站资料",
    requester: "米站",
    intro: "把手上的资料整个文件夹拖进来就行，我们会自动分好；分不准的再请您看一眼。",
    defaults: { expiresInDays: 14, rounds: "many", maxFiles: 500, retainDays: 30 },
    pipeline: DEFAULT_PIPELINE,
    sort: { threshold: 0.7, textChars: 2000, instructions: "这是一家企业为做官网提供的资料。" },
    items: [
      {
        key: "products",
        title: "产品照片",
        ask: "每个主要产品 3–5 张，白底或实拍都可以；有视频也欢迎。",
        sortHint: "产品本身是画面主体",
        accept: ["image", "video"],
        required: true,
        pipeline: {
          image: [
            { op: "image.resize" },
            {
              op: "describe",
              prompt: "用一两句话写出画面里的产品：外形、颜色、材质、可见的文字。只写看得见的。",
            },
          ],
        },
      },
      {
        key: "factory",
        title: "工厂与车间",
        ask: "厂房、产线、仓库、团队，照片或视频。",
        accept: ["image", "video"],
        allowNone: true,
      },
      {
        key: "company",
        title: "公司介绍",
        ask: "公司简介、画册、PPT、旧官网的文字都行；懒得写也可以录一段语音讲讲。",
        accept: ["pdf", "doc", "slides", "text", "audio"],
        required: true,
      },
      {
        key: "specs",
        title: "产品目录与参数表",
        ask: "型号、规格、参数，Excel 或 PDF。",
        accept: ["sheet", "pdf"],
        allowNone: true,
      },
      {
        key: "certificates",
        title: "资质证书",
        ask: "营业执照、ISO、产品认证。拍照或扫描都行，字要能看清。",
        accept: ["image", "pdf"],
        allowNone: true,
        pipeline: {
          image: [{ op: "image.tile" }],
          pdf: [{ op: "pdf.pages", maxPages: 10, longEdge: 2400 }],
        },
      },
      {
        key: "logo",
        title: "Logo",
        ask: "有源文件（AI、SVG、PDF）最好；没有就一张清晰的图。",
        accept: ["image", "pdf", "any"],
        required: true,
        note: "off",
        pipeline: {
          image: [{ op: "file.keep" }, { op: "image.resize", longEdge: 1024, format: "png" }],
          pdf: [{ op: "file.keep" }, { op: "pdf.pages", maxPages: 1 }],
          any: [{ op: "file.keep", maxBytes: 104857600 }],
        },
      },
    ],
  },
};
