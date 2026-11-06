# dsh-weknora-memory

**DeepSeek Harness 的分层上下文引擎。** 把本机 WeKnora 知识库变成一份可预算、可审计、可编辑的长期上下文：每一轮只放进去"该进去的那一小段"，并且能说清它为什么进去、占了多少字符、什么时候会退场。

> A layered context engine for DeepSeek Harness — budgeted injection, recency decay, hot/warm/cold tiering, standing profile cards and fact-conflict surfacing on top of a local WeKnora instance.

它不是"再来一个 RAG 检索器"。检索只是这条管线里的一环，真正决定回答质量的是注入治理：**什么能进、进多少、以什么身份进、什么时候该退场**。

---

## 一、它要解决的四类结构性失效

| 失效 | 表现 | 本插件的对策 |
|---|---|---|
| **会话失忆** | 换个会话就要重新交代背景，模型对你的偏好、项目约束一无所知 | 每轮自动检索并注入，记忆不依赖模型主动调用 |
| **检索噪声反噬** | top-k 直接塞进上下文，三条无关片段挤走一条真正相关的 | 字符/条数/阈值三重闸 + 冷热配额，席位有限且按价值分配 |
| **记忆不可控** | 记忆写死在系统提示词里，改不了、看不见、不知道它今天带了什么 | 侧边面板直读直写，带预算条与命中统计；每轮实际注入内容全程可见 |
| **旧材料永久占坑** | 三个月前的会话记录和昨天的结论同权，反复抢占 3 个注入席位 | 时效衰减 + 冷热分层，旧片段需要新的证据才能重新入场 |

## 二、三层上下文，三份互不侵占的预算

| 层 | 内容 | 预算（默认值） | 打分 / 衰减 |
|---|---|---|---|
| **常驻层** `pinned_constraints` | 行为准则、硬约束 | 12 条 · 1500 字符 · 单条 ≤200 字符 | 永不参与打分、永不衰减 |
| **画像层** `profile` | soul 规则 / user 画像 / agent 工作习惯 | soul 6 张·300 字 · user 3 张·200 字 · agent 6 张·400 字，单卡 ≤80 字 | 永不打分，按类配额裁剪 |
| **检索层** `weknora_context` | 本轮检索命中的片段 | ≤2400 字符 · 最多 3 条 | 打分 + 衰减 + 分层共同决定 |

三份预算是**相加而不是共享**的：检索块撑满 2400 字符也不会挤掉常驻准则（`lib/config.js:26,31`）；画像层按类型分账，避免 user 卡把 agent 层吃空（`lib/config.js:104-110`）。

上限是硬编码契约，不是建议值：`timeoutMs` 被钳到 **4000ms**、`maxChars` 被钳到 **2400**（`lib/config.js:19,26` 的 `TIMEOUT_CAP_MS` / `CHARS_CAP`），手改配置文件也撑不破。

## 三、一轮里到底发生了什么

```
agent/pre-step
 ├── 查询构造      取本轮用户文本；8–500 字符，过短追问拼上一轮（mergeContextQuery）
 ├── 分库并发检索  每个 kb 一次 /knowledge-search，共享同一 deadline
 ├── RRF 融合     k=60，跨库合并，不让单个库垄断席位（mergeKbGroups）
 ├── 来源权重      sourceWeights 正则 × 系数（默认 ^hs- ×0.35，降权但不删除）
 ├── 时效衰减      w = min(1, max(0.35, 2^(-ageDays/30)))      （decay.js）
 ├── 冷热分层      hot ≤14d · warm ≤90d · cold >90d，coldTopK=0
 ├── 阈值闸        minScore 0.1 且 ≥ 本轮最高分的 45%
 ├── 会话去重      本会话已注入过的 chunk 不再重复占用席位
 ├── 邻块扩展      ±1 个相邻 chunk，400ms 子预算，把碎片补成完整段落
 ├── 事实卡        同 subject 多张在效卡 → 块尾追加一行「⚠ 冲突未决」；superseded ×0.3
 └── 渲染          以独立来源消息追加（source.kind = plugin:weknora-inject）
```

最后一步的细节很重要：注入块是**一条独立的 user-role 消息**，不是对你的提问的改写，模型能分辨"这是检索来的历史材料"而不是"用户刚说的新任务"。

## 四、写入侧：这些记忆是谁写进去的

本包只做**读**（每轮注入）和**人工编辑**（面板）。把原文、结论、画像写进 WeKnora 与 `data/profile.json` 的，是宿主侧的定时任务——**装上本插件不会自动获得这些任务**，它们是同一套体系的另一半，这里把契约写清楚，方便你自己实现或用别的工具替代。

| 任务 | 触发 | 做什么 | 写到哪里 |
|---|---|---|---|
| `DSH-Session-Ingest` | 每小时 | 把**已结束且空闲 ≥10 分钟**的会话转录**原样**入库，跳过子代理会话；单篇 ≤200,000 字符，最多保留 150 篇；失败重试 3 次，入库后轮询索引 ≤600 秒 | 库① 会话记忆 |
| `DSH-Session-Distill` | 每日 04:30 | 从最近会话里抽取结论 / 约束 / 偏好 / 教训，一次最多 3 个会话、3 篇文档，输入 ≤30,000 字符、每轮 ≤1500 字符、每会话 ≤8 条，语义去重阈值 0.66 | 库② 知识 |
| `DSH-Memory-Dream` | 每日 03:30 | **夜间做梦**：五阶段 S0 收拢 → S1 分组 → S2 裁决 → S3 落账 → S4 报告。裁决同主题事实卡的取代 / 冲突 / 重复，**只改 header 里的状态字段，正文逐字保留**；单夜 ≤60 次 LLM 调用、≤20 次更新；支持 `--dry-run` / `--no-llm` 零成本演练 | 库② 知识（事实卡状态） |
| `profile-writer` | 紧接做梦之后，且**只在做梦 rc=0 时** | `data/profile.json` 的**唯一写入者**：新卡一律 `proposed`，至少等一夜才复核；复核必须同时满足「有来源 / 不重复 / 不冲突 / 正文 ≤60 字」才转正，否则保持 `proposed` 并记日志；被插件标了 degrade 的 `active` 卡转 `disputed`，下一轮起不再进常驻块 | 常驻层画像 |
| `DSH-Memory-Weekly` | 每周 | 体检：跨库重复、失效文档、状态异常 | 三库 |

三库的分工不是随手划的：

- **库① 会话记忆**存原文，回答"当时到底怎么说的"；
- **库② 知识**存结论，一条结论一张事实卡，回答"这件事定了没有、为什么"；
- **库③ 资料**存你手工入库的原始文件，回答"这份规范里怎么写的"。

**为什么写入侧必须独立于插件：** 写要 LLM、要数据库权限、要能被人工审计；而读侧每轮都跑，必须零依赖、可静默失败。两者混在一起，任何一次写入故障都会变成一次会话故障。

**为什么画像文件只允许一个写入者：** 常驻内容每轮注入、跨会话传播——一旦被污染，后面没有任何一次检索能把它纠正回来。所以插件侧只读，任何新内容只能走 `proposed → 隔夜复核 → active` 这条闸门。

### 本包自带的写入侧参考实现（`writers/`，默认不启用）

上面那张表是**它应该长什么样**；本包把同一套约定做成了可复制的实现，放在 `writers/`，**随包分发但默认不运行**——装上插件不会创建任何计划任务、不会写任何文档。

| 文件 | 作用 |
|---|---|
| `writers/ingest.mjs` | 会话转录 → 库①（幂等：同名文档走 PUT 复用 id） |
| `writers/distill.mjs` | 会话 → 结论 → 库②（含语义去重，LLM 走 WeKnora 会话网关） |
| `writers/dream.mjs` | 事实卡裁决 S0–S4，只改 header 状态；`--self-test` 可离线跑 |
| `writers/profile-writer.mjs` | `data/profile.json` 的唯一写入者；不带 `--write` 就只打印 diff |
| `writers/register-tasks.ps1` | 幂等注册/更新计划任务（`-Unregister` 撤销，`-Prefix`、`-Times` 可改） |
| `writers/run-all.cmd` | 手动跑一轮：`run-all.cmd [--dry-run] [ingest|distill|dream|profile]` |

三步启用：

```powershell
cd node_modules/@rennimars/dsh-weknora-memory
copy writers\config.example.json writers\writer.config.json   # 填 apiUrl / sessionsRoot / kbs
$env:WEKNORA_API_KEY = "<你的 key>"                            # 只从环境变量读，不落文件
powershell -ExecutionPolicy Bypass -File writers\register-tasks.ps1
```

四条纪律：

- **凭证只在环境变量**：`writer.config.json` 里的 `apiKey` 字段会被忽略；缺 `WEKNORA_API_KEY` 时只提示，不带该请求头。
- **演练零成本**：四个脚本都支持 `--dry-run`（不写库、不写文件、不写 state）；`dream.mjs --dry-run --no-llm` 连一次 LLM 都不发。
- **共用一份 HTTP**：读侧 `lib/retrieve.js` 与写入侧全部走 `lib/weknora.js`，`X-API-Key` 头与错误词表只有一处实现。
- **失败可见**：退出码 0/1/2/3 有明确语义，失败是一条可读错误而不是异常栈——这与读侧「失败即静默」刻意相反，因为定时任务没有人在看着。

## 五、几个刻意的设计取舍

**不改用户原话。** 注入永远走追加，避免任何"提示词污染"式的隐蔽改写。

**状态不依赖数据库。** WeKnora 的 Postgres 不对宿主暴露端口，且实测 `chunks.metadata` 4950 行全为 NULL——想往库里写 tier 或命中时间根本无处可写（`decay.js` 文件头注释）。所以状态落在插件自己的 `data/tier-state.json`：tmp 写入 + rename 原子替换，上限 4000 条，读-合-写是一个同步序列，同进程两个写者不会交错。

**冷启动不误伤。** hotDays 14 / warmDays 90 是"先测量"的值：今天入库的每一块都还年轻，全部算 hot，分层层在真实年龄积累起来之前是一个空操作；唯一立即改变行为的开关是 `coldTopK=0`，它只挡"又旧又从没命中过"的块（`tier.js:38-46`）。

**禁止双重惩罚。** 已经被 `sourceWeights` 降过权的命中，不再叠加衰减（`applyToSourceWeights=false`）：惩罚只施加一次，日志里写明是哪一种。

**失败即静默。** 后端挂了、超时、配置写错——全部返回未改动的 decision，这一轮只是不注入。会话不会因为记忆层而失败或卡住（`index.js` 文件头注释）。

**自动写入与人工编辑分权。** `data/profile.json` 的自动更新属于夜间任务，插件本身只读；面板里的编辑是用户显式动作。这条边界防的是"每轮注入、每轮重算"的自我强化——一个被污染的事实否则会跨会话传播。

## 六、可观测性

侧边栏「记忆」页签，三个视图：

- **记忆卡** —— 编辑正文 / 启停 / 新增 / 删除，每条都带预算条（用了多少字符、离上限多远）
- **记忆统计** —— 每张卡的轮次与命中次数
- **检索统计** —— 注入率、平均命中数、耗时 p50/p95、每个知识库的贡献占比

面板走**同源路由**：宿主注册 `/api/weknora-memory/state`（读）与 `/api/weknora-memory/card`（写），浏览器用相对路径调用——没有第二个端口、没有 CORS、没有令牌要同步。客户端脚本无构建、无 hooks（slot 渲染是普通函数调用，用模块级 store + class 组件），装完即用。

日志只记元数据：会话 id、耗时、命中数、字符数、结果。**不写提问原文，也不写片段正文**。

## 七、依赖

| 项 | 要求 |
|---|---|
| DSH | `>= 0.2.1-rc.3`（用到 GUI 的 `/api` Fetch 路由与 `sidebar.panellist` 槽） |
| Node | `>= 20.11` |
| WeKnora | 一个可访问实例（默认 `http://127.0.0.1:8080/api/v1`），以及至少一个知识库 |

## 八、安装

**从插件市场**：插件页 → 插件市场 → 搜索 `weknora` → 安装。

**手动**（把仓库放进 profile 的 node_modules 再登记为 bundle）：

```bash
cd "$DSH_HOME/profiles/<你的 profile>"
mkdir -p node_modules/@rennimars
git clone https://github.com/RenniMars/dsh-weknora-memory node_modules/@rennimars/dsh-weknora-memory
```

然后在同目录 `package.json` 的 `dsh.profile.bundles` 里加一行 `"@rennimars/dsh-weknora-memory"`，重启客户端。

## 九、配置

复制模板，填三样东西：

```bash
cd node_modules/@rennimars/dsh-weknora-memory
cp wk-inject.config.example.json wk-inject.config.json
```

```json
{
  "enabled": true,
  "apiUrl": "http://127.0.0.1:8080/api/v1",
  "apiKey": "",
  "kbIds": ["<知识库 id>", "<知识库 id>"],
  "kbNames": { "<知识库 id>": "知识" },
  "kbLabel": "知识"
}
```

- **apiKey 建议不要写进文件**：留空，用环境变量 `WEKNORA_API_KEY`（可选 `WEKNORA_API_URL`）注入。环境变量优先于文件，同一份配置可在不同机器上用不同 key。
- `kbIds` 就是检索范围；`kbNames` 只影响注入块里显示的中文标签。
- 模板默认 `enabled: false`，填好再改成 `true`（或删掉这一行，默认开启）。

其余参数（超时、字符上限、命中数、阈值、RRF k、邻块扩展、衰减半衰期与下限、冷热分层配额、画像卡配额、事实卡权重、日志路径）见 `lib/config.js` 的 `DEFAULT_CONFIG`，每一项都带注释说明为什么取这个值；一般不用动。

## 十、隐私与边界

- `data/profile.json`、`data/profile-stats.json`、`data/tier-state.json`、`logs/inject.log` 全部留在本机，不进仓库、不进包（`.gitignore` / `.npmignore` 都排除了）。
- 本插件不向任何第三方上报数据；所有请求只发往你自己配置的 `apiUrl`。
- 子代理会话默认不检索（`skipSubagents: true`）：子代理拿到的是被裁剪过的任务，用它的文本去检索只会污染主会话的记忆。

## 十一、开发

```bash
npm test          # node --test test/*.mjs，59 个用例
```

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 入口：`apply` 注册 `agent/pre-step` + 挂面板路由 |
| `lib/injector.js` | 注入装配：身份判定、查询构造、去重、消息组装 |
| `lib/retrieve.js` | WeKnora 分库并发检索、RRF 融合、来源权重、邻块扩展 |
| `lib/format.js` | 阈值筛选、事实卡解析、冲突行、受控块渲染 |
| `lib/tier.js` | hot/warm/cold 分层与回温规则 |
| `lib/decay.js` | 时效衰减与命中回写（原子 JSON 状态） |
| `lib/config.js` | 配置加载、钳制、日志 |
| `lib/panel.js` / `lib/client.js` | 面板同源路由 / GUI 侧渲染 |
| `lib/weknora.js` | 唯一 HTTP 客户端：读侧与写入侧共用 |
| `writers/*.mjs` | 可选写入侧：ingest / distill / dream / profile-writer |

## License

MIT © RenniMars

## 路线图 / Roadmap

本项目的演进计划分阶段推进：先给"检索准不准"一把可量化的尺子，再让事实卡的冲突能被裁决、遗忘能被解释、主题能被归并，最后才谈写入门控。
完整计划（13 节，含每阶段的目标、改动点、验收与回滚）：[docs/ROADMAP.md](docs/ROADMAP.md)
当前版本 0.3.0；计划可分批实现、每批独立验收，欢迎在 Issue 区按阶段提方案。
想改这份计划，请先开 Issue 讨论，达成一致后再改文档，不要直接改 ROADMAP.md。
