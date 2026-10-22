# AGENTS.md

material-intake：agent 用来向人收资料的工具。契约（类型、操作、模板、邀请、输出、费用）只在 `docs/format.md`，改字段先改它；本文件是改代码时要守的规矩。

## 这是什么，不是什么

- **独立、通用。** 不认识任何调用它的系统和行业：领域词只能出现在 `templates/`，`src/shared/independence.test.ts` 扫 `src/`，出现就失败。归类的类别是这次邀请的收集项，不是引擎里的类别。
- 单 Worker：`/i/<id>.<key>`（对方的页面和 `/api/*`）、`/admin/act/<动作>` 与 `/mcp`（agent，Bearer `ADMIN_TOKEN`）、`/llms.txt`（说明书 = `docs/format.md`，公开）、每天一次的 scheduled（删过保留期的原件）。
- 存储：D1（邀请、轮次、文件、产物、声明、调用流水），R2（图片产物与 `file.keep` 的原件）。

## 不变量（改之前先看）

1. **来源写明，模型不冒充对方。** 归属 `by: client | model | none`；对方没改不等于确认（还是 model）。描述、转写是 `class: "model"`，不给对方看，也不是对方的原话。
2. **原件不保存**，除了 `file.keep`（只能写在某一项里，提交时分片上传，`retainDays` 后删）。服务端过境（toMarkdown）转完即弃，不写 R2/D1/日志。模型只读产物。
3. **产物 = f(sha256, op, params)**，同一邀请内只算一次（`products` 主键）。步骤 id = `<op>.<规范参数哈希前 8 位>`（`shared/sha256.ts`），地址、输出路径、产物键都用它。
4. **处理到哪一步不存**，从产物推（`shared/model.ts` 的 `fileState`）。文件表里只有事实、归属、对方能修的失败。
5. **失败按「对方能不能修」分**：文件的问题 → `failure`，挡提交；我们这边的问题（模型出错、上限、转换服务）→ 产物 `skipped` + `reason`，不挡。
6. **费用不会超过上限，靠构造**：`calls` 表既是流水也是余额；预留是一条带条件的 INSERT（`worker/ledger.ts`），结算不超过预留。没有另存的「已花」。
7. **轮次只追加**：提交时生成 manifest 冻结进 `rounds.manifest`；已提交轮次的文件这个链接看不到、改不了。
8. **声音按块处理，不整段放在内存里**：转写一段一段上传（往前看一段，所以最后一段总能标 `last`），服务端以流交给 Whisper。
9. **事实以容器为准**：视频/录音的时长和有没有音轨读 `moov`（`shared/media.ts`），解码结果对不上就当没解出来——浏览器缺解码器时会静默地给错的结果。

## 代码在哪

- `src/shared/`（纯，配测试）：`kinds`（文件头判类型）、`ops`（操作表与参数）、`template`（合成与校验）、`sort`（怎么问、怎么落）、`budget`（价格与估价）、`facts`（尺寸、切块、抽帧、「丢了什么」）、`media`（容器事实）、`model`（推导状态）、`manifest`（输出与 MAP.md）、`page`（对方页面的形状与承诺）、`tools`（agent 动作清单）。
- `src/worker/`：`index.ts`（路由）、`intake.ts`（对方的每个动作）、`admin.ts`（agent 的每个动作）、`mcp.ts`、`models.ts`（所有模型调用）、`ledger.ts`（费用）、`store.ts`（D1 行 ↔ 类型）、`retention.ts`。
- `src/web/`：`process.ts`（浏览器端操作与解码，含 libheif 的 HEIC 兜底）、`audio.ts`（声音：MP4/MOV 流式解码 + 重采样，其他整文件解码）、`icons.ts`（文件图标）、`main.ts`（页面与调度）。不是 Effect 代码（`.effect-skill.json` 的 hostTooling）。
- `templates/index.ts`：模板数据。`mockup/`：设计稿（静态，不进门禁）。

## 门禁

- `vp run ci` = 类型（web / worker / shared / scripts）+ lint + 测试 + `check:effect` + build；`pre-push` 和 CI 同一个列表。
- 业务代码（worker、shared）不用 `async`/`await`/`Date`/`try`：时间从 `Clock`（`worker/clock.ts`），格式化用 `shared/time.ts` 的 `isoOf`。可执行边缘只有 `runRetention`（scheduled）。

## 本地

- `node scripts/db-local.mjs migrate`，然后 `vp dev --port 5190`（`.dev.vars` 里放 `ADMIN_TOKEN`）。**Workers AI 本地也连线上**（`bindings.ai({ dev: { remote: true } })`）：本地跑一轮会真花钱（一轮十几个文件实测约 $0.002）。
- `INTAKE_BASE=http://localhost:5190 node scripts/do.ts create --template website-kickoff --ref X` 拿链接。`testdata/`（不入库）放测试资料；不要用真实客户资料测试。
- 浏览器面板里没法从系统拖文件：在页面里构造带 `webkitGetAsEntry` 的 drop 事件，走的是同一条路径。

## 部署

- 资源：Worker `material-intake`（`https://material-intake.yansir.workers.dev`，每天 03:17 UTC 的 scheduled）、D1 `material-intake`（APAC）、R2 `material-intake-files`（APAC）。密钥 `ADMIN_TOKEN` 在 `data/prod-secrets.json`（不入库）。
- **push 到 `main` 自动部署**（Cloudflare Workers Builds，设置在 Cloudflare 里）：构建 `pnpm exec vp run ci`，部署 `pnpm exec cf d1 migrations apply <D1 id> && pnpm exec cf deploy --prebuilt`——先迁移再部署，门禁或迁移失败就不部署。看构建：`cf builds list --external-script-id <Worker tag>`、`cf builds logs get <build-uuid>`。
- 手动部署仍可用：`vp run deploy`（ci → 远程迁移 → `cf deploy --secrets-file data/prod-secrets.json`）。部署的是工作区，不是某个提交。
- **部署后跑一次** `node scripts/smoke.ts`（`vp run smoke`）：扮演对方对线上走完整流程，约 $0.001；页面本身在本地 dev 里验（浏览器面板里的线上页面没法从本机读测试文件）。
