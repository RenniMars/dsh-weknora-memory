# Changelog

## 0.3.1 — 常驻块按用户轮次投递
- **修（超时）**：`lib/weknora.js` 的 `request()` 改用自带 `AbortController` + `setTimeout` 计时，不再用 `AbortSignal.timeout()`——后者的定时器是 unref 的，事件循环里没有别的句柄时（Node 20 的 `node --test` 进程正是这样）它会随循环一起退出，挂起的请求永远不会结算，整份测试文件以 `cancelledByParent` 收场。现在 `finally` 里清计时器，超时原因是 `timeout`、连接错误仍是 `transport`。

- **修（画像闸门）**：`writers/profile-writer.mjs` 的复核此前只要「有来源 / 不重复 / 正文 ≤60 字」就把 `proposed` 转 `active`——一晚的静默被当成了决定。现在补上 `export const ATTEST_MIN = 3`：同一话题被反复看到（`propose()` 已有的 `attest` 合并计数）至少 3 次，或卡上 `approve: true`（`--approve` / `decide()` 写入的人工批准），才允许转正，否则记 `needs_approval_or_attest_N_of_3` 保持 `proposed`。
- **修（CI）**：`test/inject.test.mjs`、`test/layers.test.mjs` 曾 import 本机私有兄弟目录 `../../../_wk_dream/profile-writer.mjs`，本机绿、CI 上 `ERR_MODULE_NOT_FOUND`。改为仓库自带的 `../writers/profile-writer.mjs`。`test/writers.test.mjs` 的 W4 相应改成「人工批准的卡转正 + 只有 2 次证言的卡仍留 proposed」。66 个用例全绿。

- **修**：常驻/画像块（`pinned_constraints`，实测约 913 字）此前在**每个 step** 都重贴一次；DSH 的 `step()` 会把注入消息 `session.append('user/message', ...)` 写进会话，同一轮的后续步既读得到又不需要第二份。实测 `logs/inject.log` 2975 条里 2386 条（80%）是 `no_user_text` 的纯重播。
- **改**：`lib/injector.js` 新增 `pinnedForStep(sessionId, prompt)`，按本步的 prompt 文本给常驻块去重——工具续步没有 user 文本（`promptFromMessages` 返回 `""`），同一句 prompt 重复出现也算同轮。会话内第一块永远投递（`pinnedPrompt` 无该会话记录时不去重），所以「首步没有用户文本」不会让整场会话丢常驻层。
- **配置**：新增 `pinnedOncePerTurn`（默认 `true`，`lib/config.js`）。设为 `false` 恢复旧的每步投递。
- **日志**：被去重的步记 `pinned_skipped: true`、`pinned_chars: 0`，便于对前后数字。
- **测试**：新增 2 项（`test/inject.test.mjs`）：同轮续步/同句重问不复投；`pinnedOncePerTurn: false` 保持旧行为。5 个测试文件全绿。

## 0.3.0 — 写入侧随包发布（可选组件）

- **新增 `lib/weknora.js`**：读侧与写入侧共用的唯一 HTTP 客户端（base URL 拼接、`X-API-Key` 头、超时、`no_api_url|timeout|transport|http_<status>` 错误词表）。`lib/retrieve.js` 的两处内联 fetch 已改为调用它，59 个既有用例保持全绿。
- **新增 `writers/`（默认不启用）**：`ingest.mjs` 会话原文入库①、`distill.mjs` 结论蒸馏入库②、`dream.mjs` 事实卡裁决 S0–S4、`profile-writer.mjs` 画像唯一写入者。四者都支持 `--config` / `--dry-run` / `--verbose`，失败返回可读错误与明确退出码，`--dry-run` 不写库、不写文件、不写 state。
- **新增 `writers/register-tasks.ps1`** 与 **`writers/run-all.cmd`**：幂等注册/撤销计划任务（当前用户级，不需要管理员），以及手动跑一轮（可选单步）。
- **凭证纪律**：`writer.config.json` 的 `apiKey` 字段被忽略，只从 `WEKNORA_API_KEY` 环境变量读取；发布包内不含任何密钥、知识库 id 或本机绝对路径。
- **新增测试 `test/writers.test.mjs`（5 项）**：import 零副作用、`--help` 退出 0、桩地址 dry-run 不落盘且错误可读、`proposed→active`/`degrade→disputed` 只改状态字段、发布树无凭证/无机器路径。总计 64 个用例。
- 安装后**不会**自动注册任何计划任务，读侧行为与 0.2.2 完全一致。

## 0.2.2 — 补上写入侧（文档）

- 新增「写入侧：这些记忆是谁写进去的」一节：三条管道（每小时会话原文入库① / 每日 04:30 结论蒸馏入库② / 每日 03:30 夜间做梦裁决事实卡）与画像写入器的闸门（`proposed` → 隔夜复核 → `active`，被标记 degrade 的卡转 `disputed`），含触发时间、配额与失败策略。
- 明确边界：这些定时任务属于**宿主侧**，不随本包分发；装上插件不会自动获得写入能力。写清这点是为了不让"记忆插件"的想象越界成实际行为。
- 补三库分工（原文 / 结论 / 原始材料）与"为什么写入必须独立于读侧"的取舍说明。
- 代码与默认配置未改动。

## 0.2.1 — 介绍重写（仅文档）

- README 从“功能清单”改写为**机制说明**：三层上下文（常驻 / 画像 / 检索）各自的独立预算、一轮之内的完整检索管线（分库并发 → RRF → 来源权重 → 时效衰减 → 冷热分层 → 阈值 → 会话去重 → 邻块扩展 → 事实卡冲突 → 渲染），以及每处设计取舍的理由。
- 新增「它要解决的四类结构性失效」与「问题 → 机制」对照，明确本插件是**注入治理层**而非又一个 RAG 检索器。
- 补充硬预算契约（`TIMEOUT_CAP_MS` 4000 / `CHARS_CAP` 2400）、状态文件不依赖数据库的原因（Postgres 不暴露端口、`chunks.metadata` 全 NULL）、禁止双重惩罚、子代理不检索等边界说明。
- 包 `description` 与 `keywords` 同步改写（面向市场的定位句）。
- 安装段修正仓库作用域大小写（`@RenniMars` → `@rennimars`）。
- 代码与默认配置未改动。

## 0.2.0 — first public release

- **每轮检索注入**：把 WeKnora 命中的片段作为独立的 `<weknora_context>` 消息注入，带字符上限、分数阈值与每个库的权重。
- **常驻画像卡**：soul / user / agent 三层，永不参与打分、每轮必带，各有配额与字数上限。
- **侧边面板**（GUI 侧边栏「记忆」）：改卡片正文、启用/停用、新增、删除；记忆统计与检索统计（注入率、命中率、p50/p95、每库贡献）。
- **面板走宿主同源路由**：注册 `/api/weknora-memory/state`（读）与 `/api/weknora-memory/card`（写）两条精确 Fetch 路由，没有第二个端口、没有 CORS、没有令牌同步。
- **客户端不依赖 React hooks**：槽位以普通函数调用渲染，hook 会抛 React error #321；面板改为模块级 store + class 生命周期。
- **配置从环境变量取凭证**：`WEKNORA_API_URL` / `WEKNORA_API_KEY` 优先于配置文件，发布包里不带任何密钥与知识库 id。
- 任意失败（后端不可达、超时、配置缺失）一律静默降级，只影响这一轮的注入。