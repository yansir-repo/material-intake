/**
 * agent 的命令行：动作清单就是 src/shared/tools.ts（和 MCP 同一套），这里只把参数转成 JSON 交给 POST /admin/act/<动作>。
 *
 *   node scripts/do.ts guide | ops | templates | template --template ID
 *   node scripts/do.ts validate --template ID [--overrides overrides.json]
 *   node scripts/do.ts create   --template ID [--overrides overrides.json] [--ref MZ-021] [--budget 2]
 *   node scripts/do.ts list | status --id inv_… | wait --id inv_… [--after 0] [--timeout 600]
 *   node scripts/do.ts result --id inv_… [--round N] [--md] [--out file]
 *   node scripts/do.ts fetch  --id inv_… --round N --path files/<f>/<step>/<name> [--out file]
 *   node scripts/do.ts rotate | close | revoke --id inv_…
 *   node scripts/do.ts budget --id inv_… --usd 2 | --usd none
 *
 * 令牌：环境变量 INTAKE_ADMIN_TOKEN，否则 data/prod-secrets.json 或 .dev.vars 里的 ADMIN_TOKEN。
 * 地址：--base 或 INTAKE_BASE（默认线上）。不在门禁里：它要连线上、要令牌，是操作命令。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const DEFAULT_BASE = "https://material-intake.yansir.workers.dev";

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "";
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? undefined : argv[i + 1];
};
const has = (name: string): boolean => argv.includes(`--${name}`);

const fail = (message: string): never => {
  console.error(message);
  return process.exit(1);
};

const token = (): string => {
  const fromEnv = process.env["INTAKE_ADMIN_TOKEN"];
  if (fromEnv) return fromEnv;
  if (existsSync("data/prod-secrets.json")) {
    const t = (
      JSON.parse(readFileSync("data/prod-secrets.json", "utf8")) as { ADMIN_TOKEN?: string }
    ).ADMIN_TOKEN;
    if (t) return t;
  }
  if (existsSync(".dev.vars")) {
    const m = /^ADMIN_TOKEN=(.*)$/m.exec(readFileSync(".dev.vars", "utf8"));
    if (m?.[1]) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return fail(
    "没有找到 ADMIN_TOKEN：设环境变量 INTAKE_ADMIN_TOKEN，或放进 data/prod-secrets.json / .dev.vars",
  );
};
const base = (flag("base") ?? process.env["INTAKE_BASE"] ?? DEFAULT_BASE).replace(/\/$/, "");

const act = async (name: string, args: Record<string, unknown>): Promise<Response> => {
  const res = await fetch(`${base}/admin/act/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) fail(`${res.status}: ${await res.text()}`);
  return res;
};

const print = async (res: Response) => {
  const type = res.headers.get("content-type") ?? "";
  const out = flag("out");
  if (type.startsWith("application/json")) {
    const text = JSON.stringify(await res.json(), null, 2);
    if (out) writeFileSync(out, text);
    else console.log(text);
  } else if (type.startsWith("text/")) {
    const text = await res.text();
    if (out) writeFileSync(out, text);
    else console.log(text);
  } else {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!out) fail(`binary (${type}, ${bytes.length} bytes): pass --out <file>`);
    writeFileSync(out!, bytes);
    console.error(`wrote ${out} (${bytes.length} bytes)`);
  }
};

const overrides = (): Record<string, unknown> => {
  const file = flag("overrides");
  const o = file ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  const budget = flag("budget");
  if (budget !== undefined) o["budget"] = { usd: Number(budget) };
  return o;
};
const id = () => flag("id") ?? fail("--id inv_… is required");
const int = (name: string) => (flag(name) === undefined ? undefined : Number(flag(name)));

const main = async () => {
  switch (cmd) {
    case "guide":
    case "ops":
    case "templates":
    case "list":
      return print(await act(cmd, {}));
    case "template":
      return print(await act(cmd, { template: flag("template") }));
    case "validate":
      return print(await act(cmd, { template: flag("template"), overrides: overrides() }));
    case "create":
      return print(
        await act(cmd, {
          template: flag("template"),
          overrides: overrides(),
          ref: flag("ref") ?? "",
        }),
      );
    case "status":
    case "rotate":
    case "close":
    case "revoke":
      return print(await act(cmd, { id: id() }));
    case "wait": {
      const after = int("after") ?? 0;
      const until = Date.now() + (int("timeout") ?? 600) * 1000;
      for (;;) {
        const r = (await (await act("wait", { id: id(), after, timeout: 25 })).json()) as {
          submitted: number | null;
        };
        if (r.submitted !== null) return console.log(JSON.stringify(r));
        if (Date.now() >= until) return fail("timed out waiting for a round");
      }
    }
    case "result":
      return print(
        await act(cmd, { id: id(), round: int("round"), format: has("md") ? "md" : "json" }),
      );
    case "fetch":
      return print(await act(cmd, { id: id(), round: int("round"), path: flag("path") }));
    case "budget": {
      const usd = flag("usd");
      if (usd === undefined) fail("--usd <number> | --usd none");
      return print(await act(cmd, { id: id(), usd: usd === "none" ? null : Number(usd) }));
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
  }
};

void main();
