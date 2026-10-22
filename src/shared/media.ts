/**
 * 读 ISO BMFF 容器（MP4 / M4A / MOV / HEIC）的事实，不经过浏览器的解码器。
 *
 * 为什么需要：浏览器缺某种解码器时，decodeAudioData 和 <audio> 的元数据可能不报错、只给出不对的时长——静默地错；
 * 「有没有音轨」浏览器也没有可靠的接口（audioTracks 只有 Safari 有）。容器里的 mvhd 时长和 trak 的 handler
 * 是写在文件里的事实：拿它和解码结果对照，解码「成功」但时长对不上就是没解出来。
 */

export type BoxHeader = {
  readonly type: string;
  readonly start: number;
  readonly headerSize: number;
  readonly size: number;
};

/** 读一个 box 的头（`at` 处至少要有 16 字节）。size 为 0 表示到文件尾。 */
export const boxAt = (b: Uint8Array, at: number, fileSize: number): BoxHeader | null => {
  if (at + 8 > b.length) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const small = v.getUint32(at);
  const type = String.fromCharCode(b[at + 4]!, b[at + 5]!, b[at + 6]!, b[at + 7]!);
  if (small === 1) {
    if (at + 16 > b.length) return null;
    const size = v.getUint32(at + 8) * 0x100000000 + v.getUint32(at + 12);
    return { type, start: at, headerSize: 16, size };
  }
  return { type, start: at, headerSize: 8, size: small === 0 ? fileSize - at : small };
};

const children = (b: Uint8Array, from: number, to: number): BoxHeader[] => {
  const out: BoxHeader[] = [];
  for (let at = from; at + 8 <= to;) {
    const h = boxAt(b, at, to);
    if (!h || h.size < h.headerSize) break;
    out.push(h);
    at += h.size;
  }
  return out;
};

export type MoovFacts = {
  readonly duration: number | null;
  readonly hasAudio: boolean;
  readonly hasVideo: boolean;
};

/** 一个完整的 moov box（含头）→ 时长（秒）、有没有音轨、有没有视频轨。 */
export const moovFacts = (moov: Uint8Array): MoovFacts => {
  const top = boxAt(moov, 0, moov.length);
  if (!top || top.type !== "moov") return { duration: null, hasAudio: false, hasVideo: false };
  const v = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  let duration: number | null = null;
  let hasAudio = false;
  let hasVideo = false;
  for (const box of children(moov, top.headerSize, Math.min(moov.length, top.size))) {
    if (box.type === "mvhd") {
      const body = box.start + box.headerSize;
      const version = moov[body];
      const timescale = version === 1 ? v.getUint32(body + 20) : v.getUint32(body + 12);
      const units =
        version === 1
          ? v.getUint32(body + 24) * 0x100000000 + v.getUint32(body + 28)
          : v.getUint32(body + 16);
      if (timescale > 0) duration = Math.round((units / timescale) * 10) / 10;
    }
    if (box.type === "trak") {
      const mdia = children(moov, box.start + box.headerSize, box.start + box.size).find(
        (x) => x.type === "mdia",
      );
      const hdlr = mdia
        ? children(moov, mdia.start + mdia.headerSize, mdia.start + mdia.size).find(
            (x) => x.type === "hdlr",
          )
        : undefined;
      if (hdlr) {
        const at = hdlr.start + hdlr.headerSize + 8; // version/flags(4) + pre_defined(4)
        const handler = String.fromCharCode(moov[at]!, moov[at + 1]!, moov[at + 2]!, moov[at + 3]!);
        if (handler === "soun") hasAudio = true;
        if (handler === "vide") hasVideo = true;
      }
    }
  }
  return { duration, hasAudio, hasVideo };
};

/**
 * 解码出来的时长和容器里写的对得上吗。容器没写（null）时不判断；解码结果短于容器时长的 90% 就是没解出来
 * （留 10% 给编码器在首尾的填充和取整）。
 */
export const decodedMatches = (
  containerSeconds: number | null | undefined,
  decodedSeconds: number,
): boolean =>
  containerSeconds === null || containerSeconds === undefined || containerSeconds <= 0
    ? decodedSeconds > 0
    : decodedSeconds >= containerSeconds * 0.9;
