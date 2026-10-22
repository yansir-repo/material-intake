/**
 * agent 的动作清单：名字、说明、入参。MCP（/mcp）、运营接口（/admin/act/<名字>）、命令行（scripts/do.ts）都读这一份；
 * 动作的实现在 worker/admin.ts。
 */

export type JsonSchema = Readonly<Record<string, unknown>>;
export type ToolDef = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
};

const str = (description: string): JsonSchema => ({ type: "string", description });
const int = (description: string): JsonSchema => ({ type: "integer", description });
const obj = (
  properties: Record<string, JsonSchema>,
  required: ReadonlyArray<string> = [],
): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const id = { id: str("invite id, e.g. inv_ab3k9q2m7x") };

const OVERRIDES: JsonSchema = {
  type: "object",
  description:
    "Changes on top of the template (docs/format.md §5): title, requester, intro, items (same key = shallow merge; {key, remove:true} deletes; new key appends), pipeline (per kind), sort, expiresInDays, rounds (one|many), maxFiles, retainDays, budget ({usd} or omit for no cap).",
};

export const TOOLS: ReadonlyArray<ToolDef> = [
  {
    name: "guide",
    description:
      "The format: kinds, operations, templates, invites, the respondent's side, rounds, output, budget. Read this first. Plain markdown.",
    inputSchema: obj({}),
  },
  {
    name: "ops",
    description:
      "The operation table: what each op accepts, where it runs, its class (exact/lossy/model) and parameter ranges.",
    inputSchema: obj({}),
  },
  {
    name: "templates",
    description: "List the templates (id, version, title).",
    inputSchema: obj({}),
  },
  {
    name: "template",
    description: "One template as data.",
    inputSchema: obj({ template: str("template id") }, ["template"]),
  },
  {
    name: "validate",
    description:
      "Resolve template + overrides into the invite snapshot without creating anything. Returns the expanded snapshot, or every problem.",
    inputSchema: obj({ template: str("template id"), overrides: OVERRIDES }, ["template"]),
  },
  {
    name: "create",
    description:
      "Create an invite and return its link (the key is shown only here and on rotate — keep the url). Send the url only to the respondent. ref is your own opaque id.",
    inputSchema: obj(
      {
        template: str("template id"),
        overrides: OVERRIDES,
        ref: str("your own reference, e.g. a project code"),
      },
      ["template"],
    ),
  },
  {
    name: "list",
    description: "All invites: id, ref, title, status, rounds submitted.",
    inputSchema: obj({}),
  },
  {
    name: "status",
    description:
      "One invite: status, rounds, the draft round's files per item and unassigned, money (spent / reserved / cap in USD).",
    inputSchema: obj(id, ["id"]),
  },
  {
    name: "wait",
    description:
      "Wait (up to timeout seconds, max 25) until a round after `after` is submitted. Returns {submitted: round | null}. Call again to keep waiting.",
    inputSchema: obj(
      { ...id, after: int("last round you have (0 = none)"), timeout: int("seconds, ≤ 25") },
      ["id"],
    ),
  },
  {
    name: "result",
    description:
      "A submitted round: manifest.json (format=json, default) or MAP.md (format=md). Default: the latest round.",
    inputSchema: obj(
      { ...id, round: int("round number"), format: { type: "string", enum: ["json", "md"] } },
      ["id"],
    ),
  },
  {
    name: "fetch",
    description:
      "One artifact by its manifest path (files/<fileId>/<stepId>/<name>). Text comes back as text; images and originals as base64 with their content type.",
    inputSchema: obj(
      { ...id, round: int("round number"), path: str("artifact path from the manifest") },
      ["id", "round", "path"],
    ),
  },
  {
    name: "rotate",
    description:
      "New link for the invite; the old link stops working at once. Returns the new url.",
    inputSchema: obj(id, ["id"]),
  },
  {
    name: "close",
    description:
      "Stop collecting (submitted rounds are kept; originals are deleted retainDays later).",
    inputSchema: obj(id, ["id"]),
  },
  {
    name: "revoke",
    description: "Revoke the invite: the link stops working (submitted rounds are kept).",
    inputSchema: obj(id, ["id"]),
  },
  {
    name: "budget",
    description:
      "Change the invite's model-spending cap in USD (null = no cap). Lowering it below what is spent makes every later model call skipped.",
    inputSchema: obj(
      { ...id, usd: { type: ["number", "null"], description: "cap in USD, or null" } },
      ["id", "usd"],
    ),
  },
];
