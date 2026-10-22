import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** 引擎不认识任何调用它的系统、任何行业：领域词只允许出现在 templates/ 里（docs/format.md §0）。 */
const FORBIDDEN = [
  "米站",
  "建站",
  "网站",
  "官网",
  "装修",
  "户型",
  "产品",
  "工厂",
  "车间",
  "证书",
  "Logo",
  "logo",
  "客户",
  "MZ-",
  "zeroy",
];

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });

describe("the engine is independent of any caller", () => {
  it("src/ contains no domain words", () => {
    const hits = files("src")
      .filter((f) => !f.endsWith("independence.test.ts"))
      .flatMap((f) => {
        const text = readFileSync(f, "utf8");
        return FORBIDDEN.filter((w) => text.includes(w)).map((w) => `${f}: ${w}`);
      });
    expect(hits).toEqual([]);
  });
});
