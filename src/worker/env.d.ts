// Bindings and secrets the Worker reads (cloudflare.config.ts; `.dev.vars` locally, `--secrets-file` in production).
declare namespace Cloudflare {
  interface Env {
    /** 邀请、轮次、文件、产物、费用流水（migrations/）。 */
    DB: D1Database;
    /** 产物（图片）与 file.keep 的原件。 */
    FILES: R2Bucket;
    /** The page shell, served after an invite's key checks out. */
    ASSETS: Fetcher;
    /** Workers AI：toMarkdown、clef-flash / clef-omni、DeepSeek V4.1 Flash、Whisper。 */
    AI: Ai;
    ADMIN_TOKEN: string;
    PUBLIC_URL: string;
  }
}
