import { describe, expect, it } from "vitest";
import { decodedMatches, moovFacts } from "./media.ts";

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const box = (type: string, body: number[]) => [...u32(8 + body.length), ...ascii(type), ...body];
const mvhd = (timescale: number, units: number) =>
  box("mvhd", [
    0,
    0,
    0,
    0,
    ...u32(0),
    ...u32(0),
    ...u32(timescale),
    ...u32(units),
    ...Array.from({ length: 80 }, () => 0),
  ]);
const trak = (handler: string) =>
  box(
    "trak",
    box("mdia", [
      ...box(
        "mdhd",
        Array.from({ length: 24 }, () => 0),
      ),
      ...box("hdlr", [
        0,
        0,
        0,
        0,
        ...u32(0),
        ...ascii(handler),
        ...Array.from({ length: 12 }, () => 0),
        0,
      ]),
    ]),
  );

describe("moov facts: what the container says, not the decoder", () => {
  it("reads the duration and the kinds of tracks", () => {
    const moov = new Uint8Array(box("moov", [...mvhd(44100, 44100 * 13), ...trak("soun")]));
    expect(moovFacts(moov)).toEqual({ duration: 13, hasAudio: true, hasVideo: false });
    const film = new Uint8Array(
      box("moov", [...mvhd(1000, 20_000), ...trak("vide"), ...trak("soun")]),
    );
    expect(moovFacts(film)).toEqual({ duration: 20, hasAudio: true, hasVideo: true });
    const silent = new Uint8Array(box("moov", [...mvhd(600, 4800), ...trak("vide")]));
    expect(moovFacts(silent)).toEqual({ duration: 8, hasAudio: false, hasVideo: true });
  });
  it("is not fooled by something that is not a moov", () => {
    expect(moovFacts(new Uint8Array(box("free", [1, 2, 3])))).toEqual({
      duration: null,
      hasAudio: false,
      hasVideo: false,
    });
  });
});

describe("a decode that 'succeeds' with almost nothing is a failed decode", () => {
  it("compares against the container's duration", () => {
    expect(decodedMatches(13, 0.0115)).toBe(false);
    expect(decodedMatches(13, 12.9)).toBe(true);
    expect(decodedMatches(null, 0.5)).toBe(true);
    expect(decodedMatches(null, 0)).toBe(false);
  });
});
