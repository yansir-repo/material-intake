/**
 * 对方的页面（docs/format.md §6）。服务端是唯一的状态：每个动作的回应是那个文件的新样子（PageFile），页面只渲染它。
 * 页面自己只记：这次会话里拿到的 File 对象（原件留在对方电脑上）、产物的本地预览、被拒的文件、哪些是刚落下的。
 */
import "./style.css";
import { isSystemFile, KIND_LABEL, type AcceptKind } from "../shared/kinds.ts";
import type { PageFile, PageStep, PageView } from "../shared/page.ts";
import { ORIGINAL_PART_BYTES, SORT_AUDIO_SECONDS } from "../shared/page.ts";
import { TRANSCRIBE_SEGMENT_SECONDS } from "../shared/ops.ts";
import { Accumulator, openAudio, wavOf, type Audio } from "./audio.ts";
import { fileIcon } from "./icons.ts";
import { factsOf, Fixable, hashFile, runBrowserOp, sniffFile } from "./process.ts";

// ---- 和服务端说话 -----------------------------------------------------------------------------------

const BASE = location.pathname.replace(/\/$/, "");
type Reply = { ok?: boolean; error?: string; file?: PageFile } & Record<string, unknown>;

const call = async (
  method: string,
  path: string,
  body?: BodyInit | object,
  headers: Record<string, string> = {},
): Promise<Reply> => {
  const isRaw =
    body instanceof Blob ||
    body instanceof FormData ||
    body instanceof ArrayBuffer ||
    body instanceof Uint8Array;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers:
      body !== undefined && !isRaw ? { "content-type": "application/json", ...headers } : headers,
    body: body === undefined ? undefined : isRaw ? (body as BodyInit) : JSON.stringify(body),
  });
  const data = (await res
    .json()
    .catch(() => ({ ok: false, error: `服务没有回应（${res.status}）` }))) as Reply;
  if (!res.ok || data.ok === false) throw new Error(data.error ?? `请求失败（${res.status}）`);
  return data;
};

// ---- 状态 ----------------------------------------------------------------------------------------

type Local = {
  file?: File;
  urls: Map<string, string>;
  stage: string;
  audio?: Audio;
  driving: boolean;
  again: boolean;
};
const S: {
  view: PageView | null;
  local: Map<string, Local>;
  preparing: { path: string; stage: string }[];
  rejected: { path: string; reason: string }[];
  ignored: number;
  sel: string | null;
  showRej: boolean;
  skipped: boolean;
  own: Set<string>;
  mode: "collect" | "done";
  submitting: string;
  fresh: Set<string>;
} = {
  view: null,
  local: new Map(),
  preparing: [],
  rejected: [],
  ignored: 0,
  sel: null,
  showRej: false,
  skipped: sessionStorage.getItem(`${BASE}:skip`) === "1",
  own: new Set(),
  mode: "collect",
  submitting: "",
  fresh: new Set(),
};

const localOf = (id: string): Local => {
  let l = S.local.get(id);
  if (!l) {
    l = { urls: new Map(), stage: "", driving: false, again: false };
    S.local.set(id, l);
  }
  return l;
};
const upsert = (f: PageFile | undefined) => {
  if (!f || !S.view) return;
  const prev = S.view.files.find((x) => x.id === f.id);
  if (prev?.assignment?.item !== f.assignment?.item && f.assignment?.item) S.fresh.add(f.id);
  S.view = {
    ...S.view,
    files: prev ? S.view.files.map((x) => (x.id === f.id ? f : x)) : [...S.view.files, f],
  };
  render();
};
const fileById = (id: string) => S.view?.files.find((f) => f.id === id);
const itemByKey = (key: string) => S.view?.items.find((i) => i.key === key);

const $ = <T extends Element>(s: string) => document.querySelector<T>(s)!;
const esc = (v: string | number | undefined | null) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${Math.round(n / 1024)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
const base = (p: string) => p.split("/").pop() ?? p;
const dir = (p: string) => p.split("/").slice(0, -1).join("/");
const ext = (p: string) => (base(p).includes(".") ? base(p).split(".").pop()!.toUpperCase() : "");
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const pct = (p: number) => `${Math.round(p * 100)}%`;

let toastTimer = 0;
const toast = (msg: string) => {
  const t = $<HTMLDivElement>("#toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove("on"), 4200);
};

// ---- 文件进来 -------------------------------------------------------------------------------------

type Picked = { file: File; path: string };
type Entry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file: (ok: (f: File) => void, bad: (e: unknown) => void) => void;
  createReader?: () => {
    readEntries: (ok: (e: Entry[]) => void, bad: (e: unknown) => void) => void;
  };
};

const walk = async (entry: Entry, prefix = ""): Promise<Picked[]> => {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile)
    return [{ file: await new Promise<File>((ok, bad) => entry.file(ok, bad)), path }];
  if (!entry.isDirectory || !entry.createReader) return [];
  const reader = entry.createReader();
  const all: Entry[] = [];
  for (;;) {
    const batch = await new Promise<Entry[]>((ok, bad) => reader.readEntries(ok, bad));
    if (!batch.length) break;
    all.push(...batch);
  }
  return (await Promise.all(all.map((e) => walk(e, path)))).flat();
};
const fromDrop = async (dt: DataTransfer): Promise<Picked[]> => {
  const entries = [...dt.items].flatMap((i) => {
    const e = i.webkitGetAsEntry?.() as unknown as Entry | null | undefined;
    return e ? [e] : [];
  });
  if (!entries.length) return [...dt.files].map((file) => ({ file, path: file.name }));
  return (await Promise.all(entries.map((e) => walk(e)))).flat();
};
const fromInput = (input: HTMLInputElement): Picked[] =>
  [...(input.files ?? [])].map((file) => ({
    file,
    path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
  }));

/** 同时处理的文件数（浏览器解码很吃内存）。 */
const POOL = 3;
let active = 0;
const tasks: (() => Promise<void>)[] = [];
const pump = () => {
  while (active < POOL && tasks.length) {
    active++;
    const t = tasks.shift()!;
    void t().finally(() => {
      active--;
      pump();
    });
  }
};
const enqueue = (t: () => Promise<void>) => {
  tasks.push(t);
  pump();
};

const accepts = (item: string | null, kind: AcceptKind) =>
  item ? (itemByKey(item)?.accept.includes(kind) ?? false) : true;

/**
 * 放进来一批文件。重新放进来的文件：和这一轮里某个文件路径、内容都一样时，服务端返回原来那个，这里接着处理它，
 * 所以刷新页面后「重新拖一次」就能续上，不会重复。
 */
const addPicked = (picked: Picked[], item: string | null) => {
  if (!S.view?.open) return;
  S.mode = "collect";
  for (const p of picked) {
    if (isSystemFile(p.path)) {
      S.ignored++;
      continue;
    }
    const slot = { path: p.path, stage: "排队" };
    S.preparing.push(slot);
    enqueue(async () => {
      try {
        const allowAny = item !== null && accepts(item, "any");
        const sniffed = await sniffFile(p.file, p.path, allowAny);
        if (!sniffed.ok) {
          S.rejected.push({ path: p.path, reason: sniffed.reason });
          return;
        }
        if (item === null && !S.view!.items.some((i) => i.accept.includes(sniffed.kind))) {
          S.rejected.push({ path: p.path, reason: `这次不收${KIND_LABEL[sniffed.kind]}。` });
          return;
        }
        slot.stage = "读取中";
        render();
        const sha256 = await hashFile(p.file);
        let facts = {};
        try {
          facts = await factsOf(p.file, sniffed.kind);
        } catch (e) {
          if (!(e instanceof Fixable)) throw e;
        }
        const r = await call("POST", "/api/files", {
          name: p.file.name,
          path: p.path,
          bytes: p.file.size,
          sha256,
          kind: sniffed.kind,
          mime: sniffed.mime,
          facts,
          item: item !== null && accepts(item, sniffed.kind) ? item : "",
        });
        const f = r.file!;
        localOf(f.id).file = p.file;
        upsert(f);
        void drive(f.id);
      } catch (e) {
        S.rejected.push({ path: p.path, reason: e instanceof Error ? e.message : String(e) });
      } finally {
        S.preparing = S.preparing.filter((x) => x !== slot);
        render();
      }
    });
  }
  render();
};

// ---- 推进一个文件 ---------------------------------------------------------------------------------

const stage = (id: string, s: string) => {
  localOf(id).stage = s;
  render();
};

/** 一个文件的声音（打开一次，按块读；不把整段解码结果留在内存里）。 */
const audioOf = async (f: PageFile, file: File): Promise<Audio> => {
  const l = localOf(f.id);
  l.audio ??= await openAudio(file, f.facts);
  return l.audio;
};

const fail = async (id: string, op: string, e: unknown) => {
  const reason =
    e instanceof Fixable ? e.message : `处理出错：${e instanceof Error ? e.message : String(e)}`;
  upsert((await call("POST", `/api/files/${id}/failure`, { op, reason })).file);
};

const runStep = async (f: PageFile, s: PageStep, file: File): Promise<PageFile | undefined> => {
  if (s.input === "browser") {
    stage(f.id, f.kind === "video" ? "抽帧中" : "处理中");
    const out = await runBrowserOp(s.op, s.params, file);
    const form = new FormData();
    form.set("meta", JSON.stringify(out.meta));
    if (out.text !== undefined) form.set("text", out.text);
    const urls = localOf(f.id).urls;
    for (const x of out.files) {
      form.append("file", new File([x.blob], x.name, { type: x.blob.type }));
      urls.set(`${s.stepId}/${x.name}`, URL.createObjectURL(x.blob));
    }
    stage(f.id, "上传中");
    return (await call("POST", `/api/files/${f.id}/steps/${s.stepId}/product`, form)).file;
  }
  if (s.input === "transit") {
    if (file.size > (S.view?.limits.transitBytes ?? 0))
      throw new Fixable("文件太大，服务器转不了文字。请拆成几份，或导出为更小的 PDF。");
    stage(f.id, "服务器转换中");
    return (await call("POST", `/api/files/${f.id}/steps/${s.stepId}/transit`, file)).file;
  }
  if (s.input === "audio") {
    stage(f.id, "读取声音");
    const audio = await audioOf(f, file);
    if (audio.kind !== "ok") {
      if (f.kind === "audio")
        throw new Fixable(
          audio.kind === "undecodable" && audio.why === "too-large"
            ? "录音太大，浏览器转不了。请剪成几段再放进来。"
            : "这个浏览器解不了这段录音。请用最新的 Chrome、Edge 或 Safari 打开本页，或把录音转成 mp3 再放进来。",
        );
      // 视频：没有声音不转写；有声音但浏览器解不了，是我们这边的问题，记下来、不挡对方
      return (
        await call("POST", `/api/files/${f.id}/steps/${s.stepId}/skip`, {
          reason: audio.kind === "none" ? "not-applicable" : "decode-error",
        })
      ).file;
    }
    // 一段一段转：攒满一段（≤ 30 分钟）就上传，内存里最多一段
    const total = Math.max(
      1,
      Math.ceil((f.facts.duration ?? audio.seconds) / TRANSCRIBE_SEGMENT_SECONDS),
    );
    let index = s.meta?.segmentsDone ?? 0;
    let cur: PageFile | undefined = f;
    const acc = new Accumulator(TRANSCRIBE_SEGMENT_SECONDS);
    const send = async (pcm: Int16Array, last: boolean) => {
      stage(f.id, total > 1 ? `转文字 ${Math.min(index + 1, total)}/${total}` : "转文字");
      const q = `index=${index}&last=${last ? 1 : 0}&start=${index * TRANSCRIBE_SEGMENT_SECONDS}&duration=${pcm.length / 16000}`;
      cur = (await call("POST", `/api/files/${f.id}/steps/${s.stepId}/audio?${q}`, wavOf(pcm)))
        .file;
      index++;
    };
    // 往前看一段：攒满的一段先拿着，等确定后面还有才作为「非最后一段」发出去，所以最后一段总能标成 last
    let ready: Int16Array | null = null;
    stage(f.id, total > 1 ? `转文字 ${index + 1}/${total}` : "读取声音");
    for await (let block of audio.blocks(index * TRANSCRIBE_SEGMENT_SECONDS)) {
      while (block.length) {
        block = acc.push(block);
        if (acc.full) {
          if (ready) await send(ready, false);
          ready = acc.drain();
        }
      }
    }
    if (acc.filled > 0) {
      if (ready) await send(ready, false);
      ready = acc.drain();
    }
    if (ready) await send(ready, true);
    else if (f.kind === "audio") throw new Fixable("这段录音里没有读到声音。请换一份。");
    else
      return (
        await call("POST", `/api/files/${f.id}/steps/${s.stepId}/skip`, { reason: "decode-error" })
      ).file;
    return cur;
  }
  return undefined;
};

/** 把一个文件推进到能推进的地方：先做处理链里还缺的，再归类，归类后按新处理链补做，最后转写、描述。 */
const drive = async (id: string): Promise<void> => {
  const l = localOf(id);
  if (l.driving) {
    l.again = true;
    return;
  }
  l.driving = true;
  try {
    for (let guard = 0; guard < 8; guard++) {
      let f = fileById(id);
      if (!f || f.failure) return;
      const file = l.file;
      // 浏览器端、过境：缺哪个做哪个
      const pending = f.steps.find(
        (s) => s.status === "missing" && (s.input === "browser" || s.input === "transit"),
      );
      if (pending) {
        if (!file) return;
        try {
          upsert(await runStep(f, pending, file));
        } catch (e) {
          await fail(id, pending.op, e);
          return;
        }
        continue;
      }
      // 总区里的：归类
      if (f.assignment === null) {
        stage(id, "分类中");
        let clip: { blob: Blob; seconds: number } | null = null;
        if (f.kind === "audio" && file) {
          // 给 clef-omni 听开头 ≤ 240 秒
          try {
            const audio = await audioOf(f, file);
            if (audio.kind === "ok") {
              const acc = new Accumulator(SORT_AUDIO_SECONDS);
              for await (let block of audio.blocks(0)) {
                block = acc.push(block);
                if (acc.full) break;
              }
              const seconds = acc.filled;
              if (seconds > 0) clip = { blob: wavOf(acc.drain()), seconds };
            }
          } catch {
            clip = null;
          }
        }
        upsert(
          (await call("POST", `/api/files/${id}/sort?seconds=${clip?.seconds ?? 0}`, clip?.blob))
            .file,
        );
        continue;
      }
      // 转写（分段）
      const audio = f.steps.find(
        (s) => (s.status === "missing" || s.status === "partial") && s.input === "audio",
      );
      if (audio) {
        if (!file) return;
        try {
          upsert(await runStep(f, audio, file));
        } catch (e) {
          await fail(id, audio.op, e);
          return;
        }
        continue;
      }
      // 描述（服务端读已存的图片产物）
      if (f.steps.some((s) => s.status === "missing" && s.input === "products")) {
        stage(id, "处理中");
        f = (await call("POST", `/api/files/${id}/describe`)).file;
        upsert(f);
      }
      if (!l.again) return;
      l.again = false;
    }
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  } finally {
    l.driving = false;
    l.stage = "";
    render();
  }
};

// ---- 对方的动作 ------------------------------------------------------------------------------------

const assign = async (id: string, item: string) => {
  try {
    upsert((await call("PUT", `/api/files/${id}/assign`, { item })).file);
    void drive(id);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
};
const removeFile = async (id: string) => {
  try {
    await call("DELETE", `/api/files/${id}`);
    if (S.view) S.view = { ...S.view, files: S.view.files.filter((f) => f.id !== id) };
    if (S.sel === id) S.sel = null;
    render();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
};
const noteTimers = new Map<string, number>();
const saveNote = (key: string, none: boolean, note: string) => {
  if (!S.view) return;
  S.view = { ...S.view, notes: { ...S.view.notes, [key]: { none, note } } };
  clearTimeout(noteTimers.get(key));
  noteTimers.set(
    key,
    window.setTimeout(() => {
      call("PUT", `/api/items/${key}`, { none, note }).catch((e: unknown) =>
        toast(e instanceof Error ? e.message : String(e)),
      );
    }, 500),
  );
};

/** 提交：先把要原件的文件分片传上去，再提交这一轮。 */
const submit = async () => {
  if (!S.view) return;
  try {
    const needs = S.view.files.flatMap((f) =>
      f.steps.filter((s) => s.op === "file.keep" && s.status !== "done").map((s) => ({ f, s })),
    );
    for (const [i, { f, s }] of needs.entries()) {
      const file = S.local.get(f.id)?.file;
      if (!file) throw new Error(`请把「${f.name}」重新放进来：原件要在提交时上传。`);
      S.submitting = `上传原件 ${i + 1}/${needs.length}：${f.name}`;
      render();
      const start = await call("POST", `/api/files/${f.id}/steps/${s.stepId}/original/start`);
      const parts: { partNumber: number; etag: string }[] = [];
      const n = Math.max(1, Math.ceil(file.size / ORIGINAL_PART_BYTES));
      for (let p = 0; p < n; p++) {
        S.submitting = `上传原件 ${i + 1}/${needs.length}：${f.name}（${Math.round((p / n) * 100)}%）`;
        render();
        const r = await call(
          "PUT",
          `/api/files/${f.id}/steps/${s.stepId}/original/part?upload=${encodeURIComponent(String(start["uploadId"]))}&part=${p + 1}`,
          file.slice(p * ORIGINAL_PART_BYTES, (p + 1) * ORIGINAL_PART_BYTES),
        );
        parts.push({ partNumber: Number(r["partNumber"]), etag: String(r["etag"]) });
      }
      upsert(
        (
          await call("POST", `/api/files/${f.id}/steps/${s.stepId}/original/complete`, {
            uploadId: start["uploadId"],
            parts,
          })
        ).file,
      );
    }
    S.submitting = "提交中";
    render();
    const r = await fetch(`${BASE}/api/submit`, { method: "POST" }).then(
      (x) => x.json() as Promise<{ ok: boolean; problems?: { message: string }[]; error?: string }>,
    );
    if (!r.ok)
      throw new Error(r.problems?.map((p) => p.message).join("；") ?? r.error ?? "没能提交");
    S.mode = "done";
    S.sel = null;
    await load();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  } finally {
    S.submitting = "";
    render();
  }
};

// ---- 渲染 ----------------------------------------------------------------------------------------

const previewUrl = (f: PageFile, stepId: string, name: string) =>
  S.local.get(f.id)?.urls.get(`${stepId}/${name}`) ??
  `${BASE}/api/files/${f.id}/steps/${stepId}/${name}`;
/** 缩略图：第一个做好的图片产物（视频取联系表）。 */
const thumbOf = (f: PageFile): string | null => {
  for (const s of f.steps) {
    if (s.status !== "done" || !s.meta?.files?.length) continue;
    if (!["image.resize", "image.tile", "video.frames", "pdf.pages"].includes(s.op)) continue;
    const names = s.meta.files;
    return previewUrl(
      f,
      s.stepId,
      s.op === "video.frames" && s.meta.sheet ? names.at(-1)! : names[0]!,
    );
  }
  return null;
};
/** 页面图（PDF）整页显示在白底上；照片和帧铺满。 */
const thumbStyle = (f: PageFile) => {
  const u = thumbOf(f);
  if (!u) return "";
  const page =
    f.steps.some((s) => s.op === "pdf.pages" && s.status === "done") &&
    !f.steps.some(
      (s) =>
        s.op !== "pdf.pages" &&
        s.meta?.files?.length &&
        s.status === "done" &&
        s.op !== "file.keep",
    );
  return page
    ? `background:#fff url('${u}') center/contain no-repeat`
    : `background-image:url('${u}')`;
};

const readiness = (v: PageView) => {
  const items = v.items.map((it) => {
    const n = v.files.filter((f) => f.state === "ready" && f.assignment?.item === it.key).length;
    return { it, n, state: v.notes[it.key]?.none ? "none" : n ? "ok" : "todo" };
  });
  // 处理中的文件：这次会话里有原件的会继续往下走；没有的（页面刷新过）要对方重新放进来
  const stuck = v.files.filter(
    (f) => f.state === "processing" && !S.local.get(f.id)?.file && !S.local.get(f.id)?.driving,
  );
  const busy =
    v.files.filter((f) => f.state === "processing").length - stuck.length + S.preparing.length;
  const failed = v.files.filter((f) => f.state === "failed");
  const unsure = v.files.filter(
    (f) => f.state === "ready" && f.assignment !== null && f.assignment.item === null,
  );
  const missing = items.filter((x) => x.it.required && x.state === "todo");
  const ok =
    (v.files.some((f) => f.state === "ready") || Object.values(v.notes).some((n) => n.none)) &&
    !busy &&
    !stuck.length &&
    !failed.length &&
    !missing.length;
  return { items, busy, stuck, failed, unsure, missing, ok };
};

const renderTile = (f: PageFile) => {
  const isFresh = S.fresh.has(f.id);
  S.fresh.delete(f.id);
  const by =
    f.assignment?.by === "client"
      ? `<span class="by client">您放的</span>`
      : f.assignment?.by === "model"
        ? `<span class="by">自动</span>`
        : "";
  const l = S.local.get(f.id);
  const st =
    f.state === "failed"
      ? `<span class="st bad">!</span>`
      : f.state === "processing" || l?.driving
        ? `<span class="st wip"></span>`
        : "";
  const stageLine = l?.stage ? `<span class="stage">${esc(l.stage)}</span>` : "";
  const t = thumbStyle(f);
  return `<button class="tile ${S.sel === f.id ? "sel" : ""} ${isFresh ? "fresh" : ""}" data-open="${f.id}">
    <div class="im ${t ? "" : "doc"}" style="${t}">${t ? "" : fileIcon(f.kind, f.name)}</div>${by}${st}${stageLine}<div class="cap">${esc(f.name)}</div></button>`;
};

const promiseList = (v: PageView) => v.promises.map((p) => `<li>${esc(p)}</li>`).join("");

const renderHero = (v: PageView, r: ReturnType<typeof readiness>) => {
  const started = v.files.length > 0 || S.preparing.length > 0 || S.rejected.length > 0;
  const picker = `<input class="hidden-input" id="pickFiles" type="file" multiple /><input class="hidden-input" id="pickDir" type="file" webkitdirectory multiple />`;
  if (!started)
    return `<section class="hero" id="hero" data-drop="">
      <div><h2>把资料<span>整个文件夹</span>拖进来</h2>
      <p>不用先整理。每个文件处理完会自动分到下面对应的一项；拿不准的再请您看一眼。</p>
      <ul>${promiseList(v)}</ul></div>
      <div style="display:grid;gap:8px"><button class="btn" data-act="pickDir">选择文件夹</button><button class="link" data-act="pickFiles">或者选几个文件</button></div>${picker}</section>`;
  const total = v.files.length + S.preparing.length;
  const done = v.files.filter((f) => f.state !== "processing").length;
  const placed = v.files.filter((f) => f.state === "ready" && f.assignment?.item).length;
  return `<section class="hero compact" id="hero" data-drop=""><div><h2>还有？继续拖进来</h2></div>
      <div style="display:flex;gap:14px;align-items:center"><button class="link" data-act="pickDir">选择文件夹</button><button class="link" data-act="pickFiles">选文件</button></div>${picker}</section>
    <div class="live"><span><b>${done}/${total}</b>已处理</span><span><b>${placed}</b>已分好</span>${r.unsure.length ? `<span><b>${r.unsure.length}</b>拿不准</span>` : ""}
      ${S.rejected.length ? `<button class="link rej" data-act="rej">${S.rejected.length} 个没收 ${S.showRej ? "▴" : "▾"}</button>` : ""}
      ${S.ignored ? `<span class="rej">忽略 ${S.ignored} 个系统文件</span>` : ""}
      <span class="meter"><i style="width:${total ? (done / total) * 100 : 0}%"></i></span></div>
    ${S.showRej ? `<div class="rejected-list">${S.rejected.map((x) => `<div><s>${esc(x.path)}</s>${esc(x.reason)}</div>`).join("")}</div>` : ""}`;
};

/** 还没识别完的文件：按扩展名先给个图标（识别完以服务端的类型为准）。 */
const guessKind = (path: string): AcceptKind => {
  const e = ext(path).toLowerCase();
  if (["pdf"].includes(e)) return "pdf";
  if (["doc", "docx", "odt", "html", "htm", "xml"].includes(e)) return "doc";
  if (["xls", "xlsx", "xlsm", "xlsb", "csv", "ods", "numbers", "et"].includes(e)) return "sheet";
  if (["ppt", "pptx"].includes(e)) return "slides";
  if (["txt", "md", "json", "yaml", "yml"].includes(e)) return "text";
  if (["m4a", "mp3", "wav", "aac", "ogg", "oga", "flac", "amr"].includes(e)) return "audio";
  if (["mp4", "m4v", "mov", "webm", "mkv", "avi"].includes(e)) return "video";
  if (
    ["jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "avif", "bmp", "tif", "tiff"].includes(e)
  )
    return "image";
  return "any";
};

const renderWorking = (v: PageView) => {
  const pending = v.files.filter((f) => f.assignment === null && f.state !== "failed");
  if (!pending.length && !S.preparing.length) return "";
  return `<div class="working"><h4>处理中</h4><div class="tiles">${pending.map(renderTile).join("")}${S.preparing
    .slice(0, 12)
    .map(
      (p) =>
        `<div class="tile"><div class="im doc">${fileIcon(guessKind(p.path), p.path)}</div><span class="st wip"></span><span class="stage">${esc(p.stage)}</span><div class="cap">${esc(base(p.path))}</div></div>`,
    )
    .join(
      "",
    )}${S.preparing.length > 12 ? `<div class="tile"><div class="im doc">+${S.preparing.length - 12}</div><div class="cap">排队中</div></div>` : ""}</div></div>`;
};

const renderStuck = (r: ReturnType<typeof readiness>) =>
  r.stuck.length
    ? `<section class="unsure" style="border-color:var(--ink-3);background:var(--card)"><div class="unsure-head"><div><h3>${r.stuck.length} 个文件需要重新放进来</h3>
      <p>页面刷新过，这些文件还没处理完。把它们（或整个文件夹）再拖进来一次，会接着处理，不会重复。</p></div></div>
      <div class="tiles">${r.stuck.map(renderTile).join("")}</div></section>`
    : "";

const renderFailed = (r: ReturnType<typeof readiness>) =>
  r.failed.length
    ? `<section class="unsure" style="border-color:var(--red);background:rgba(194,59,34,.06)"><div class="unsure-head"><div><h3>${r.failed.length} 个文件没处理成功</h3><p>点开看原因，换一个文件或删掉。</p></div></div>
      <div class="tiles">${r.failed.map(renderTile).join("")}</div></section>`
    : "";

const renderUnsure = (v: PageView, r: ReturnType<typeof readiness>) => {
  if (!r.unsure.length) return "";
  if (S.skipped)
    return `<div class="skipped">${r.unsure.length} 个拿不准的先放着，提交时会一起交上，我们之后再看。<button class="link" data-act="unskip">现在归一下</button></div>`;
  const others = (f: PageFile) =>
    `<select class="mini" data-reassign="${f.id}"><option value="">其他…</option>${v.items
      .filter((i) => i.accept.includes(f.kind))
      .map((i) => `<option value="${i.key}">${esc(i.title)}</option>`)
      .join("")}</select>`;
  const chips = (f: PageFile) => {
    const a = f.assignment;
    if (!a || a.item !== null) return "";
    return a.candidates
      .map(
        (k) =>
          `<button class="chip" data-pick="${f.id}" data-key="${k}">${esc(itemByKey(k)?.title ?? k)}${a.scores?.[k] !== undefined ? `<small>${pct(a.scores[k]!)}</small>` : ""}</button>`,
      )
      .join("");
  };
  return `<section class="unsure"><div class="unsure-head"><div><h3>这 ${r.unsure.length} 个我们拿不准</h3><p>点一下它属于哪一项。嫌麻烦也可以先跳过，提交时会一起交上。</p></div>
    <button class="btn ghost sm" data-act="skip">先跳过</button></div>
    ${r.unsure
      .map(
        (
          f,
        ) => `<div class="urow"><div class="t" style="${thumbStyle(f)}">${thumbOf(f) ? "" : fileIcon(f.kind, f.name)}</div>
      <div style="min-width:0"><div class="n">${esc(f.name)}</div><div class="p">${esc(dir(f.path))}/</div></div>
      <div class="acts">${chips(f)}${others(f)}</div></div>`,
      )
      .join("")}</section>`;
};

const renderItem = (v: PageView, x: ReturnType<typeof readiness>["items"][number], i: number) => {
  const it = x.it;
  const files = v.files.filter((f) => f.assignment?.item === it.key && f.state !== "failed");
  const note = v.notes[it.key] ?? { none: false, note: "" };
  const label =
    x.state === "ok"
      ? `<span class="istate ok">✓ ${x.n} 个</span>`
      : x.state === "none"
        ? `<span class="istate none">您说没有</span>`
        : it.required
          ? `<span class="istate miss">还没有</span>`
          : `<span class="istate">—</span>`;
  const how = it.how
    .filter((h) => h.says.length)
    .map((h) => `<span>${esc(h.label)}：${esc(h.says.join("，"))}</span>`)
    .join("");
  return `<section class="item" id="item-${it.key}">
    <div class="ino ${x.state === "ok" ? "ok" : ""}">${String(i + 1).padStart(2, "0")}</div>
    <div>
      <div class="ihead"><h2 class="ititle">${esc(it.title)}</h2><span class="tag ${it.required ? "req" : "opt"}">${it.required ? "必交" : "可选"}</span>${label}</div>
      ${it.ask ? `<p class="iask">${esc(it.ask)}</p>` : ""}
      <div class="ihow">${how}</div>
      ${files.length ? `<div class="tiles">${files.map(renderTile).join("")}</div>` : ""}
      ${S.own.has(it.key) ? `<div class="own" data-own="${it.key}"><span>拖文件或文件夹到这里，直接算「${esc(it.title)}」</span><button class="btn ghost sm" data-ownpick="${it.key}">选择…</button><input class="hidden-input" id="own-${it.key}" type="file" multiple /></div>` : ""}
      <div class="ifoot">
        ${it.allowNone && !files.length ? `<label><input type="checkbox" data-none="${it.key}" ${note.none ? "checked" : ""}/> 没有这项</label>` : ""}
        ${it.note !== "off" ? `<input class="note" data-note="${it.key}" value="${esc(note.note)}" placeholder="${note.none ? "为什么没有？（可选）" : it.note === "required" ? "请写一句说明" : "想补充一句？（可选）"}" />` : ""}
        ${S.own.has(it.key) ? "" : `<button class="link" data-ownopen="${it.key}">单独补传</button>`}
      </div>
    </div></section>`;
};

const renderArtifact = (f: PageFile, s: PageStep) => {
  const files = s.meta?.files ?? [];
  const url = (n: string) => previewUrl(f, s.stepId, n);
  const where =
    s.input === "transit"
      ? "服务器 · 原件已删"
      : s.input === "original"
        ? "原件"
        : "在您的浏览器里";
  let body = "";
  if (s.status === "skipped")
    body = `<div style="font-size:12.5px;color:var(--ink-3)">${s.input === "audio" && s.meta === undefined ? "" : "这一步没有做成（我们这边的原因），不影响提交。"}</div>`;
  else if (s.op === "image.resize") {
    const local = S.local.get(f.id)?.file;
    body = `<div class="compare"><figure><figcaption>您的原图 · ${f.facts.width}×${f.facts.height}</figcaption>${local ? `<div class="img" style="background-image:url('${localOriginal(f.id)}')"></div>` : `<div class="gone">留在您的电脑上</div>`}</figure>
      <figure><figcaption>我们收到的 · ${s.meta?.width}×${s.meta?.height}</figcaption><div class="img" style="background-image:url('${url(files[0] ?? "")}')"></div></figure></div>`;
  } else if (s.op === "image.tile")
    body = `<div class="tgrid" style="grid-template-columns:repeat(${s.meta?.cols ?? 1},1fr)">${files.map((n) => `<div style="background-image:url('${url(n)}')"></div>`).join("")}</div>`;
  else if (s.op === "video.frames") {
    const frames = s.meta?.sheet ? files.slice(0, -1) : files;
    body = `<div class="sheet">${frames.map((n, i) => `<div style="background-image:url('${url(n)}')"><span>${mmss(s.meta?.frames?.[i] ?? 0)}</span></div>`).join("")}</div>`;
  } else if (s.op === "pdf.pages")
    body = `<div class="pages">${files.map((n, i) => `<div style="background:#fff url('${url(n)}') center/cover"><span>${i + 1}</span></div>`).join("")}</div>`;
  else if (s.text !== undefined)
    body = `<div class="md">${esc(s.text || "（几乎没有文字）")}</div>`;
  else if (s.op === "file.keep")
    body = `<div style="font-size:12.5px;color:var(--ink-2)">${s.status === "done" ? "原件已上传。" : `原件 ${esc(f.name)} · ${size(f.bytes)}，点「提交」时上传。`}</div>`;
  else if (s.op === "transcribe")
    body = `<div style="font-size:12.5px;color:var(--ink-3)">${s.status === "done" ? "转出来的文字不在这里显示。" : s.status === "partial" ? `已转 ${s.meta?.segmentsDone} 段` : "还没转。"}</div>`;
  return `<div class="art"><div class="ah"><b>${esc(s.say)}</b><span>${where}</span></div>${body}${s.lost ? `<div class="lost">${esc(s.lost)}</div>` : ""}</div>`;
};

const originals = new Map<string, string>();
const localOriginal = (id: string): string => {
  const file = S.local.get(id)?.file;
  if (!file) return "";
  let u = originals.get(id);
  if (!u) {
    u = URL.createObjectURL(file);
    originals.set(id, u);
  }
  return u;
};

const specOf = (f: PageFile) => {
  const x = f.facts;
  return [
    ext(f.name),
    x.width ? `${x.width}×${x.height}` : "",
    x.duration ? mmss(x.duration) : "",
    x.pages ? `${x.pages} 页` : "",
    x.slides ? `${x.slides} 页` : "",
    size(f.bytes),
  ]
    .filter(Boolean)
    .join(" · ");
};

const renderDrawer = () => {
  const d = $<HTMLElement>("#drawer");
  const v = S.view;
  const f = S.sel ? fileById(S.sel) : undefined;
  if (!v || !f || S.mode !== "collect") {
    d.classList.remove("open");
    return;
  }
  const a = f.assignment;
  const where =
    a?.by === "client"
      ? `您放在「${esc(itemByKey(a.item)?.title)}」`
      : a?.by === "model"
        ? `自动分到「${esc(itemByKey(a.item)?.title)}」<span style="color:var(--ink-3)"> · 把握 ${pct(a.p)}</span>`
        : f.state === "ready"
          ? "还没归类"
          : "处理中…";
  const opts = v.items
    .filter((i) => i.accept.includes(f.kind))
    .map(
      (i) =>
        `<option value="${i.key}" ${a?.item === i.key ? "selected" : ""}>${esc(i.title)}</option>`,
    )
    .join("");
  const shown = f.steps
    .filter((s) => s.status !== "missing" || s.op === "file.keep" || s.op === "transcribe")
    .filter((s) => s.op !== "describe");
  d.innerHTML = `<button class="x" data-act="close">×</button>
    <h3>${esc(f.name)}</h3><div class="dp">${esc(f.path)}</div>
    ${
      f.failure
        ? `<div class="dsec"><div class="fail">${esc(f.failure.reason)}</div><p style="display:flex;gap:10px"><button class="btn ghost sm" data-remove="${f.id}">删掉，换一个</button></p></div>`
        : `<div class="dsec"><h4>归到</h4><div class="assign">${where}
      ${a?.by === "model" ? `<div class="why">不对就改一下；不改也行。</div>` : ""}
      ${f.state === "ready" && v.open ? `<select data-reassign="${f.id}">${a?.item ? "" : `<option value="">选一项…</option>`}${opts}</select>` : ""}</div></div>`
    }
    <div class="dsec"><h4>处理</h4><div class="xform">${esc(specOf(f))}</div>${!S.local.get(f.id)?.file && f.state === "processing" ? `<div class="redrop">请把这个文件重新放进来，会接着处理。</div>` : ""}</div>
    ${shown.length ? `<div class="dsec"><h4>我们收到的就是这些</h4>${shown.map((s) => renderArtifact(f, s)).join("")}</div>` : ""}
    ${v.open ? `<div class="dsec"><button class="link" data-remove="${f.id}">不交这个文件</button></div>` : ""}`;
  d.classList.add("open");
};

const renderReceipt = (v: PageView) => {
  const last = v.earlier.at(-1);
  if (!last) return "";
  return `<div class="receipt"><h4>回执 · 第 ${last.round} 轮 · ${last.submittedAt.slice(0, 16).replace("T", " ")}</h4><table>
    ${last.items
      .map(
        (it) =>
          `<tr><td>${esc(it.title)}</td><td>${it.status === "provided" ? `${it.names.length} 个文件<div class="names">${it.names.map(esc).join("　")}</div>` : it.status === "none" ? `没有${it.note ? `：${esc(it.note)}` : ""}` : "—"}</td></tr>`,
      )
      .join("")}
    ${last.unassigned.length ? `<tr><td>未归类</td><td>${last.unassigned.length} 个文件<div class="names">${last.unassigned.map(esc).join("　")}</div></td></tr>` : ""}
  </table></div>`;
};

const render = () => {
  const v = S.view;
  const app = $<HTMLDivElement>("#app");
  if (!v) return;
  const ae = document.activeElement as HTMLInputElement | null;
  const nk = ae?.dataset?.["note"];
  const caret = ae?.selectionStart ?? null;

  if (!v.open || S.mode === "done") {
    const why =
      v.closedReason === "expired"
        ? "这个链接已经过期了"
        : v.closedReason === "revoked"
          ? "这个链接已经作废了"
          : v.closedReason === "closed"
            ? "资料已经收齐"
            : "";
    app.innerHTML = `<div class="done"><div class="kicker">${esc(v.requester)} · ${esc(v.title)}</div>
      ${S.mode === "done" && v.earlier.length ? `<div class="big">收到了，<em>谢谢</em>。</div><p>缺什么、要换什么，我们会再联系您${v.open && v.rounds === "many" ? "；也可以随时用同一个链接再交一轮" : ""}。</p>` : `<div class="big">${esc(why || "资料收集")}</div>`}
      ${renderReceipt(v)}
      ${v.earlier.length ? `<div class="lock">为了安全，这个链接只显示文件名，不能预览或下载已经交过的资料。</div>` : ""}
      ${v.open && v.rounds === "many" ? `<button class="btn" data-act="again">再交一轮</button>` : ""}</div>`;
    renderDrawer();
    return;
  }

  const r = readiness(v);
  const why = S.submitting
    ? S.submitting
    : r.busy
      ? `还有 ${r.busy} 个在处理`
      : r.stuck.length
        ? `${r.stuck.length} 个文件要重新放进来`
        : r.failed.length
          ? `${r.failed.length} 个文件没处理成功`
          : r.missing.length
            ? `必交还差：${r.missing.map((x) => x.it.title).join("、")}`
            : r.ok
              ? r.unsure.length
                ? `可以提交了（${r.unsure.length} 个拿不准的会一起交上）`
                : "都齐了，可以提交"
              : "还没有资料";
  app.innerHTML = `<div class="client">
    <header class="mast"><div><div class="kicker">${esc(v.requester)} 请您提供资料</div><h1>${esc(v.title)}</h1>${v.intro ? `<p>${esc(v.intro)}</p>` : ""}</div>
      <div class="meta">截止 <b>${v.expiresAt.slice(0, 10)}</b><br>${v.rounds === "many" ? "可以分几次交<br>" : ""}第 <b>${v.round}</b> 轮${v.earlier.length ? ` · 前 ${v.earlier.length} 轮已收到` : ""}</div></header>
    ${renderHero(v, r)}${renderWorking(v)}${renderStuck(r)}${renderFailed(r)}${renderUnsure(v, r)}
    <div class="items">${r.items.map((x, i) => renderItem(v, x, i)).join("")}</div>
  </div>
  <div class="bar"><div class="in"><div class="msg"><b>第 ${v.round} 轮</b><span>${esc(why)}</span></div><button class="btn" data-act="submit" ${r.ok && !S.submitting ? "" : "disabled"}>提交这一轮</button></div></div>`;
  renderDrawer();
  if (nk) {
    const el = document.querySelector<HTMLInputElement>(`[data-note="${nk}"]`);
    if (el) {
      el.focus();
      if (caret !== null) el.setSelectionRange(caret, caret);
    }
  }
};

// ---- 事件 ----------------------------------------------------------------------------------------

document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const act = t.closest<HTMLElement>("[data-act]")?.dataset["act"];
  if (act === "pickDir") return $<HTMLInputElement>("#pickDir").click();
  if (act === "pickFiles") return $<HTMLInputElement>("#pickFiles").click();
  if (act === "submit") return void submit();
  if (act === "skip") {
    S.skipped = true;
    sessionStorage.setItem(`${BASE}:skip`, "1");
    return render();
  }
  if (act === "unskip") {
    S.skipped = false;
    sessionStorage.removeItem(`${BASE}:skip`);
    return render();
  }
  if (act === "rej") {
    S.showRej = !S.showRej;
    return render();
  }
  if (act === "close") {
    S.sel = null;
    return render();
  }
  if (act === "again") {
    S.mode = "collect";
    return render();
  }
  const open = t.closest<HTMLElement>("[data-open]");
  if (open) {
    S.sel = S.sel === open.dataset["open"] ? null : open.dataset["open"]!;
    return render();
  }
  const pick = t.closest<HTMLElement>("[data-pick]");
  if (pick) return void assign(pick.dataset["pick"]!, pick.dataset["key"]!);
  const ownOpen = t.closest<HTMLElement>("[data-ownopen]");
  if (ownOpen) {
    S.own.add(ownOpen.dataset["ownopen"]!);
    return render();
  }
  const ownPick = t.closest<HTMLElement>("[data-ownpick]");
  if (ownPick)
    return document.querySelector<HTMLInputElement>(`#own-${ownPick.dataset["ownpick"]}`)?.click();
  const rm = t.closest<HTMLElement>("[data-remove]");
  if (rm) return void removeFile(rm.dataset["remove"]!);
});
document.addEventListener("change", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === "pickDir" || t.id === "pickFiles") {
    addPicked(fromInput(t), null);
    t.value = "";
    return;
  }
  if (t.id.startsWith("own-")) {
    const key = t.id.slice(4);
    S.own.delete(key);
    addPicked(fromInput(t), key);
    t.value = "";
    return;
  }
  if (t.dataset["reassign"] && t.value) return void assign(t.dataset["reassign"], t.value);
  if (t.dataset["none"]) {
    const key = t.dataset["none"];
    saveNote(key, t.checked, S.view?.notes[key]?.note ?? "");
    render();
  }
});
document.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  const key = t.dataset["note"];
  if (key) saveNote(key, S.view?.notes[key]?.none ?? false, t.value);
});
document.addEventListener("dragover", (e) => {
  const z = (e.target as HTMLElement).closest("[data-drop], [data-own]");
  e.preventDefault();
  z?.classList.add("over");
});
document.addEventListener("dragleave", (e) =>
  (e.target as HTMLElement).closest("[data-drop], [data-own]")?.classList.remove("over"),
);
document.addEventListener("drop", (e) => {
  e.preventDefault();
  document.querySelectorAll(".over").forEach((z) => z.classList.remove("over"));
  const own = (e.target as HTMLElement).closest<HTMLElement>("[data-own]")?.dataset["own"] ?? null;
  if (!e.dataTransfer) return;
  void fromDrop(e.dataTransfer).then((picked) => {
    if (own) S.own.delete(own);
    addPicked(picked, own);
  });
});

// ---- 开始 ----------------------------------------------------------------------------------------

const load = async () => {
  const res = await fetch(`${BASE}/api/state`);
  if (!res.ok) {
    $<HTMLDivElement>("#app").innerHTML =
      `<div class="gate"><h1>打不开</h1><p>这个链接无效。请联系发给您链接的人。</p></div>`;
    return;
  }
  S.view = (await res.json()) as PageView;
  if (S.view.files.length === 0 && S.view.earlier.length > 0 && S.mode !== "collect")
    S.mode = "done";
  document.title = `${S.view.title} · ${S.view.requester}`;
  render();
};
void load().then(() => {
  if (S.view && S.view.files.length === 0 && S.view.earlier.length > 0) {
    S.mode = "done";
    render();
  }
});
