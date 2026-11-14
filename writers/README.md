# writers/ — 写入侧（可选）

本目录是**参考实现**，不随插件默认启用，安装后不会注册任何计划任务。它把会话转录、结论、事实卡状态与画像写进 WeKnora 与 `data/profile.json`；插件的读侧（每轮注入）只读这些东西。

## 契约（四个脚本都必须遵守）

1. **配置**：默认读**共享配置文件** `~/.dsh/wk-inject/wk-inject.config.json` 的 `writers` 段（与读侧插件同一份，见 `lib/writers-config.js`）；`--config <path>` 指定别的文件时只认那一份，不叠加。共享配置没有 `writers` 段时回退本目录的 `writer.config.json`，再没有就用 `config.example.json` 的默认值，并在日志里说明来源。排障用 `node writers/print-config.mjs` 看它究竟读了哪份。
2. **凭证**：`apiUrl` 形如 `http://127.0.0.1:8080/api/v1`（**含**版本前缀，与插件配置一致）；`apiKey` 取环境变量 `WEKNORA_API_KEY`，没有就用共享配置里的 `apiKey`；`writer.config.json` 里的 `apiKey` 一律忽略（避免顺手把密钥提交进仓库）。
3. **HTTP**：一律通过 `../lib/weknora.js` 的 `request()`，不自己写 fetch。
4. **路径**：`profile.path` / `profile.statsPath` 相对**包根目录**（本目录的上一级）解析，与插件一致。
5. **演练**：每个脚本都支持 `--dry-run`（只打印计划，不写库、不写文件）与 `--verbose`。
6. **退出码**：0 成功；非 0 失败。失败必须写日志并返回非 0，不能静默。
7. **幂等**：同一轮重复执行不得产生重复文档（按标题前缀 + 内容哈希判定）。

## 脚本

| 文件 | 触发建议 | 作用 |
|---|---|---|
| `ingest.mjs` | 每小时（`writers.tasks.ingest`） | 会话转录原样入库① |
| `distill.mjs` | 每日（`writers.tasks.distill`，默认 00:00） | 会话 → 结论 → 库② |
| `dream.mjs` | 每日（`writers.tasks.dream`，默认 00:30） | 事实卡裁决（S0..S4） |
| `profile-writer.mjs` | 紧接 dream（rc=0 后） | 画像唯一写入者 |

`register-tasks.ps1` 按 `writers.tasks` 的时间注册计划任务（幂等，`-Unregister` 反注册；`writers.enabled` 为 false 时拒绝注册，`-Force` 可硬来）；`run-all.cmd` 手动跑一轮。
