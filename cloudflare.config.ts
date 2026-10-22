import { bindings, defineConfig, triggers } from "cf/config";

/**
 * The Worker's single runtime fact source. `cf dev` simulates D1 / R2 locally under `.cloudflare/state`;
 * Workers AI has no local simulation, so in development it connects to the real one (it spends real money).
 */
export default defineConfig((ctx) => ({
  accountId: "d1da6c26f60e13fb006a3d4b5dae3f09",
  worker: {
    name: "material-intake",
    compatibilityDate: "2026-09-08",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/worker/index.ts",
    observability: { enabled: true },
    workersDev: true,
    previewUrls: false,
    assets: {
      // The intake page is only ever served by the Worker, behind its key.
      notFoundHandling: "none",
      runWorkerFirst: ["/", "/llms.txt", "/i/*", "/admin/*", "/mcp"],
    },
    // 原件按 retainDays 删除（worker/retention.ts）：每天一次。
    triggers: [triggers.scheduled({ schedule: "17 3 * * *" })],
    env: {
      DB: bindings.d1({ name: "material-intake", id: "79c58f08-479b-4418-8479-bb2fcdc64042" }),
      // 产物（图片）与 file.keep 的原件。键：inv/<邀请>/p/<sha256>/<步骤 id>/<文件名>。
      FILES: bindings.r2({ name: "material-intake-files" }),
      ASSETS: bindings.assets(),
      // toMarkdown、clef、DeepSeek（看图）、Whisper（转写）。
      AI: bindings.ai({ dev: { remote: true } }),
      // 运营接口与 MCP 的凭证：Authorization: Bearer <ADMIN_TOKEN>。
      ADMIN_TOKEN: bindings.secret(),
      PUBLIC_URL: bindings.text(
        ctx.mode === "development"
          ? "http://localhost:5190"
          : "https://material-intake.yansir.workers.dev",
      ),
    },
  },
}));
