# material-intake

agent 用来向人收资料的工具：agent 先配置要什么、怎么预处理、怎么分（模板 + 覆盖），得到一条链接；对方把整个文件夹拖进浏览器，
每个文件在对方的浏览器里预处理（缩图、切块、抽帧、PDF 渲染、取文字、录音转文字），模型归类后一个一个落到各项里；
agent 取回的是 agent 读得懂的资料和一份清单（manifest.json + MAP.md）。

- 契约：[docs/format.md](docs/format.md)（也是 `/llms.txt` 和 `guide` 动作的内容）
- 规矩：[AGENTS.md](AGENTS.md)
- 设计稿：[mockup/index.html](mockup/index.html)
- agent 的入口：MCP `/mcp`、`POST /admin/act/<动作>`、命令行 `node scripts/do.ts`
