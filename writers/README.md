# writers/ — 写入侧（可选）

本目录是**参考实现**，不随插件默认启用，安装后不会注册任何计划任务。它把会话转录、结论、事实卡状态与画像写进 WeKnora 与 `data/profile.json`；插件的读侧（每轮注入）只读这些东西。

## 契约（四个脚本都必须遵守）

1. **配置**：默认读本目录的 `writer.config.json`，`--config <path>` 可覆盖；缺文件时用 `config.example.json` 的默认值并在日志里说明。
2. **凭证**：`apiUrl` 形如 `http://127.0.0.1:8080/api/v1`（**含**版本前缀，与插件配置一致）；`apiKey` 留空，从环境变量 `WEKNORA_API_KEY` 取；环境变量优先。
3. **HTTP**：一律通过 `../lib/weknora.js` 的 `request()`，不自己写 fetch。
4. **路径**：`profile.path` / `profile.statsPath` 相对**包根目录**（本目录的上一级）解析，与插件一致。
5. **演练**：每个脚本都支持 `--dry-run`（只打印计划，不写库、不写文件）与 `--verbose`。
6. **退出码**：0 成功；非 0 失败。失败必须写日志并返回非 0，不能静默。
7. **幂等**：同一轮重复执行不得产生重复文档（按标题前缀 + 内容哈希判定）。

## 脚本

| 文件 | 触发建议 | 作用 |
|---|---|---|
| `ingest.mjs` | 每小时 | 会话转录原样入库① |
| `distill.mjs` | 每日 04:30 | 会话 → 结论 → 库② |
| `dream.mjs` | 每日 03:30 | 事实卡裁决（S0..S4） |
| `profile-writer.mjs` | 紧接 dream（rc=0 后） | 画像唯一写入者 |

`register-tasks.ps1` 按上面的触发时间注册计划任务（幂等，`--unregister` 反注册）；`run-all.cmd` 手动跑一轮。
