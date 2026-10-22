/**
 * 声音 → 16 kHz 单声道 PCM，按块产出，内存和文件大小无关（docs/format.md §2.2 transcribe）。
 *
 * - MP4 / MOV / M4A（手机和相机拍的几乎都是）：mp4box 读样本表，只按块读音轨的字节（视频画面的字节一个都不读），
 *   WebCodecs 的 AudioDecoder 边解边重采样。2 GB、两小时的视频也只占几十 MB。
 * - 其他容器，或浏览器没有 WebCodecs / 不支持这个编码：整文件解码（decodeAudioData），上限 600 MB。
 * 解码「成功」但时长对不上容器里写的，就是没解出来（shared/media.ts）。
 */
import { createFile, type MP4BoxBuffer } from "mp4box";
import type { SourceFacts } from "../shared/facts.ts";
import { decodedMatches } from "../shared/media.ts";
import { AUDIO_RATE } from "../shared/page.ts";
import { boxAt } from "../shared/media.ts";

/** 整文件解码要把文件读进内存：超过这个就不走这条路。 */
export const WHOLE_DECODE_MAX_BYTES = 600 * 1024 * 1024;
/** 每次重采样的块：10 秒。 */
const BLOCK_SECONDS = 10;
/** 一次从磁盘读的音轨字节（相邻样本合并成一次读）。 */
const READ_BYTES = 4 * 1024 * 1024;

export type Audio =
  | { readonly kind: "none" }
  | { readonly kind: "undecodable"; readonly why: string }
  | {
      readonly kind: "ok";
      readonly seconds: number;
      readonly blocks: (fromSeconds: number) => AsyncGenerator<Float32Array>;
    };

/** 一段源采样率的单声道 PCM → 16 kHz（用浏览器自己的重采样器）。 */
const resample = async (pcm: Float32Array, rate: number): Promise<Float32Array> => {
  if (pcm.length === 0) return pcm;
  if (rate === AUDIO_RATE) return pcm;
  const frames = Math.max(1, Math.round((pcm.length * AUDIO_RATE) / rate));
  const off = new OfflineAudioContext(1, frames, AUDIO_RATE);
  const buf = off.createBuffer(1, pcm.length, rate);
  buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
};

const mono = (data: AudioData): Float32Array => {
  const n = data.numberOfFrames;
  const out = new Float32Array(n);
  const plane = new Float32Array(n);
  for (let c = 0; c < data.numberOfChannels; c++) {
    data.copyTo(plane, { planeIndex: c, format: "f32-planar" });
    for (let i = 0; i < n; i++) out[i]! += plane[i]! / data.numberOfChannels;
  }
  return out;
};

// ---- MP4 / MOV / M4A：流式 ---------------------------------------------------------------------------

type Sample = {
  readonly offset: number;
  readonly size: number;
  readonly cts: number;
  readonly duration: number;
  readonly timescale: number;
};

/** 只把 ftyp 和 moov 喂给 mp4box（mdat 不读），拿到音轨和它的样本表。 */
const isoTrack = async (file: File) => {
  const mp4 = createFile();
  let ready = false;
  mp4.onReady = () => {
    ready = true;
  };
  for (let at = 0, guard = 0; at < file.size && guard < 64 && !ready; guard++) {
    const h = boxAt(new Uint8Array(await file.slice(at, at + 16).arrayBuffer()), 0, file.size - at);
    if (!h || h.size < h.headerSize) return null;
    if (h.type === "ftyp" || h.type === "moov") {
      if (h.size > 64 * 1024 * 1024) return null;
      const buf = (await file.slice(at, at + h.size).arrayBuffer()) as MP4BoxBuffer;
      buf.fileStart = at;
      mp4.appendBuffer(buf);
    }
    at += h.size;
  }
  mp4.flush();
  const info = mp4.getInfo();
  const track = info.audioTracks[0];
  if (!track) return { track: null } as const;
  const trak = mp4.getTrackById(track.id);
  const entry = trak.mdia.minf.stbl.stsd.entries[0] as unknown as {
    esds?: {
      esd: {
        findDescriptor(
          tag: number,
        ): { findDescriptor(tag: number): { data: Uint8Array } | undefined } | undefined;
      };
    };
  };
  const description = entry.esds?.esd.findDescriptor(4)?.findDescriptor(5)?.data;
  const samples: Sample[] = trak.samples.map((s) => ({
    offset: s.offset,
    size: s.size,
    cts: s.cts,
    duration: s.duration,
    timescale: s.timescale,
  }));
  return {
    track: {
      codec: track.codec,
      sampleRate: track.audio?.sample_rate ?? 48000,
      channels: track.audio?.channel_count ?? 2,
      description,
      samples,
      seconds: track.duration / track.timescale,
    },
  } as const;
};

const streamIso = async (file: File): Promise<Audio | null> => {
  if (typeof AudioDecoder === "undefined") return null;
  const parsed = await isoTrack(file).catch(() => null);
  if (!parsed) return null;
  if (parsed.track === null) return { kind: "none" };
  const t = parsed.track;
  const config: AudioDecoderConfig = {
    codec: t.codec,
    sampleRate: t.sampleRate,
    numberOfChannels: t.channels,
    ...(t.description ? { description: t.description } : {}),
  };
  const supported = await AudioDecoder.isConfigSupported(config).catch(() => ({
    supported: false,
  }));
  if (!supported.supported) return null;

  async function* blocks(fromSeconds: number): AsyncGenerator<Float32Array> {
    const start = t.samples.findIndex((s) => s.cts / s.timescale >= fromSeconds);
    if (start < 0) return;
    let pending: Float32Array[] = [];
    let pendingFrames = 0;
    let rate = t.sampleRate;
    let failure: Error | null = null;
    const decoder = new AudioDecoder({
      output: (data) => {
        rate = data.sampleRate;
        const m = mono(data);
        data.close();
        pending.push(m);
        pendingFrames += m.length;
      },
      error: (e) => {
        failure = e instanceof Error ? e : new Error(String(e));
      },
    });
    decoder.configure(config);
    const take = async (all: boolean): Promise<Float32Array | null> => {
      if (pendingFrames === 0 || (!all && pendingFrames < rate * BLOCK_SECONDS)) return null;
      const joined = new Float32Array(pendingFrames);
      let at = 0;
      for (const p of pending) {
        joined.set(p, at);
        at += p.length;
      }
      pending = [];
      pendingFrames = 0;
      return resample(joined, rate);
    };
    try {
      for (let i = start; i < t.samples.length;) {
        // 相邻的样本合并成一次读
        let j = i;
        const from = t.samples[i]!.offset;
        let to = from + t.samples[i]!.size;
        while (
          j + 1 < t.samples.length &&
          t.samples[j + 1]!.offset === to &&
          to - from < READ_BYTES
        ) {
          j++;
          to += t.samples[j]!.size;
        }
        const bytes = new Uint8Array(await file.slice(from, to).arrayBuffer());
        for (let k = i; k <= j; k++) {
          const s = t.samples[k]!;
          decoder.decode(
            new EncodedAudioChunk({
              type: "key",
              timestamp: Math.round((s.cts / s.timescale) * 1e6),
              duration: Math.round((s.duration / s.timescale) * 1e6),
              data: bytes.subarray(s.offset - from, s.offset - from + s.size),
            }),
          );
        }
        i = j + 1;
        if (decoder.decodeQueueSize > 200) await decoder.flush();
        if (failure) throw failure;
        const block = await take(false);
        if (block) yield block;
      }
      await decoder.flush();
      if (failure) throw failure;
      const last = await take(true);
      if (last) yield last;
    } finally {
      if (decoder.state !== "closed") decoder.close();
    }
  }
  return { kind: "ok", seconds: t.seconds, blocks };
};

// ---- 其他：整文件解码 --------------------------------------------------------------------------------

const wholeFile = async (file: File, facts: SourceFacts): Promise<Audio> => {
  if (file.size > WHOLE_DECODE_MAX_BYTES) return { kind: "undecodable", why: "too-large" };
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    return { kind: "undecodable", why: "decode-error" };
  } finally {
    void ctx.close();
  }
  if (!decodedMatches(facts.duration, decoded.duration))
    return { kind: "undecodable", why: "decode-error" };
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, c) =>
    decoded.getChannelData(c),
  );
  const rate = decoded.sampleRate;
  async function* blocks(fromSeconds: number): AsyncGenerator<Float32Array> {
    const per = rate * BLOCK_SECONDS;
    for (let at = Math.floor(fromSeconds * rate); at < decoded.length; at += per) {
      const n = Math.min(per, decoded.length - at);
      const m = new Float32Array(n);
      for (const ch of channels) for (let i = 0; i < n; i++) m[i]! += ch[at + i]! / channels.length;
      yield await resample(m, rate);
    }
  }
  return { kind: "ok", seconds: decoded.duration, blocks };
};

/** 打开一个文件的声音。没有音轨 → none；解不了 → undecodable（录音：对方能修；视频：记 skipped）。 */
export const openAudio = async (file: File, facts: SourceFacts): Promise<Audio> => {
  if (facts.hasAudio === false) return { kind: "none" };
  const streamed = await streamIso(file);
  if (streamed) return streamed;
  return wholeFile(file, facts);
};

// ---- WAV --------------------------------------------------------------------------------------------

export const wavOf = (pcm: Int16Array): Blob => {
  const head = new ArrayBuffer(44);
  const v = new DataView(head);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, AUDIO_RATE, true);
  v.setUint32(28, AUDIO_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  return new Blob([head, pcm as Int16Array<ArrayBuffer>], { type: "audio/wav" });
};

/** 按秒数攒 PCM（Int16，16 kHz），满了交出去。 */
export class Accumulator {
  private buf: Int16Array;
  private n = 0;
  constructor(readonly seconds: number) {
    this.buf = new Int16Array(Math.ceil(seconds * AUDIO_RATE));
  }
  /** 放进一块，返回放不下的剩余部分。 */
  push(block: Float32Array): Float32Array {
    const room = this.buf.length - this.n;
    const take = Math.min(room, block.length);
    for (let i = 0; i < take; i++)
      this.buf[this.n + i] = Math.max(-1, Math.min(1, block[i]!)) * 0x7fff;
    this.n += take;
    return block.subarray(take);
  }
  get full(): boolean {
    return this.n >= this.buf.length;
  }
  get filled(): number {
    return this.n / AUDIO_RATE;
  }
  drain(): Int16Array {
    const out = this.buf.slice(0, this.n);
    this.n = 0;
    return out;
  }
}
