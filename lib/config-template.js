/**
 * The commented config template a fresh install gets.
 *
 * It lives in its own module so that lib/config.js stays readable: this is documentation
 * that happens to be loadable, and every field a user might need to touch appears here once,
 * next to the sentence that explains what it does. There is exactly one config file; nothing
 * else has to be edited to make the plugin work.
 */
export const CONFIG_TEMPLATE = `// ─────────────────────────────────────────────────────────────────────
// WeKnora 记忆插件 · 唯一配置文件（改这一个文件就够）
//
// 三件事填完就能用：apiUrl（你的 WeKnora 地址）、apiKey（密钥）、kbIds（检索范围）。
// 其它字段都写了默认值，留空即默认；不确定的直接删掉也不会报错。
// 支持 // 与 /* */ 注释，允许尾随逗号。改完保存，然后重启 DSH。
//
// 不知道自己有哪些知识库？装好后问模型：
//   「用 weknora_list_knowledge_bases 列一下知识库」
// 它会把 id 和名字列出来，把 id 复制进下面的 kbIds。
// ─────────────────────────────────────────────────────────────────────
{
  // 总开关：false 时插件什么都不做（不注入，也不注册工具）。
  "enabled": true,

  // ── 1. 连接你的 WeKnora ─────────────────────────────────────────────
  // 服务地址，带 /api/v1，不要结尾斜杠。
  "apiUrl": "http://127.0.0.1:8080/api/v1",
  // API key。留空则读环境变量 WEKNORA_API_KEY；两者都空 = 连不上。
  // 建议留空、用环境变量，这样本文件可以随便备份和分享。
  "apiKey": "",
  // 多租户部署才需要，单机留空。
  "tenantId": "",

  // ── 2. 检索范围：这里为空就不会注入任何东西 ─────────────────────────
  "kbIds": [],
  // 只影响注入块里显示的中文标签：知识库 id -> 名字。
  "kbNames": {},

  // ── 3. 每轮注入多少：预算小省钱，预算大啰嗦 ────────────────────────
  // 单次检索最多等多久（硬上限 4000）；超时当这轮没有记忆，不拖慢回答。
  "timeoutMs": 3000,
  // 注入块字符硬上限 2400，写更大也会被钳回。
  "maxChars": 2400,
  // 最多塞几条片段，1-5。
  "maxHits": 3,
  "perKbHits": 2,
  "topK": 10,
  "rrfK": 60,
  // 命中一段后顺带取前后各几块（0-2），窗口更完整但更占字数。
  "neighborChunks": 1,
  "neighborTimeoutMs": 600,
  // 分数门槛：低于 minScore，或低于本轮最高分 minScoreRatio 的，一律丢弃。
  "minScore": 0.1,
  "minScoreRatio": 0.45,
  // 太短的问句（「嗯」「继续」）不检索，避免拿废话搜记忆。
  "minQueryChars": 8,
  "maxQueryChars": 500,
  // 子代理会话不检索：它的任务文本会污染主会话的记忆。
  "skipSubagents": true,

  // ── 4. 常驻层：整场只贴一次的行为准则，永不衰减、不参与打分 ─────────
  // session = 整场一次（被压缩后自动补一次）；turn = 每个用户轮次一次；step = 每步。
  "pinnedMode": "session",
  // session 模式下按轮兜底补投的间隔，0 关闭。
  "pinnedRefreshTurns": 8,
  "pinnedMaxChars": 1500,
  // 每条一句话、单条 ≤200 字。写进来的会一直跟着模型，别放一次性的事。
  "pinned": [
    { "text": "回答先给结论，再给依据；不确定就直说不确定。", "reason": "style" }
  ],

  // ── 5. 画像层：关于你和这个项目的长期事实 ───────────────────────────
  "profile": {
    "enabled": true,
    // 卡片也可以直接写在这里；留空则读 data/profile.json（夜间任务维护那个文件）。
    "cards": []
  },

  // ── 6. 时效衰减：旧材料自动降权，不删除，只是让位给新证据 ──────────
  "decay": { "enabled": true, "tauDays": 30, "floor": 0.35 },

  // ── 7. 四个工具：让模型能主动查，而不是只等自动注入 ─────────────────
  "toolsEnabled": true,
  // 工具名前缀；改了就变成 xxx_search / xxx_read_document …
  "toolPrefix": "weknora",
  // 填了 agentId 走 ReAct 管线（工具链），留空走普通 RAG 问答。
  "toolAgentId": "",
  "tools": { "listKnowledgeBases": true, "search": true, "readDocument": true, "ask": true },
  "toolMaxResults": 8,
  "toolMaxChunkChars": 1200,
  "toolRequestTimeoutMs": 30000,
  "toolChatTimeoutMs": 300000,
  "toolResourceUrls": "handle",

  // ── 8. 写入侧：四个定时脚本（会话沉淀 / 结论蒸馏 / 事实裁决 / 画像复核）
  // 默认一段全关：它们会往知识库里写文档，装插件不该顺手改你的库。要开：
  //   1) 把下面 writers.enabled 改 true，填 kbs 的三个库 id；
  //   2) 跑一次 writers/register-tasks.ps1 注册计划任务（可 -Unregister 撤掉）；
  //   3) 想看它解析成了什么：node writers/print-config.mjs
  // 注意：apiKey 不用在这里再写一份，读侧上面那个 apiKey 就是它们用的；
  //      环境变量 WEKNORA_API_KEY 仍然优先。
  "writers": {
    "enabled": false,
    // DSH 会话转录目录；留空＝脚本按平台自己猜（通常是 ~/.dsh/projects）。
    "sessionsRoot": "",
    // 三个库各自的 id：会话记忆 / 知识 / 资料。留空＝那一类不写。
    "kbs": { "session": "", "knowledge": "", "material": "" },
    // 沉淀：多久没动静的会话算结束（分钟）、单篇上限、每轮最多几篇、失败重试几次。
    "ingest": {
      "enabled": true,
      "titlePrefix": "会话记录 ",
      "settleMinutes": 10,
      "maxDocBytes": 200000,
      "maxSessionDocs": 150,
      "skipSubagentSessions": true,
      "maxAttempts": 3,
      "pollTimeoutSec": 600
    },
    // 蒸馏：每轮最多几场会话、最多写几篇、喂给模型的原文上限。
    "distill": {
      "enabled": true,
      "titlePrefix": "记忆 ",
      "maxSessionsPerRun": 3,
      "maxDocsPerRun": 3,
      "maxInputChars": 30000,
      "perTurnChars": 1500,
      "maxEntriesPerSession": 8,
      "semanticDedupe": { "enabled": true, "scoreMin": 0.66 }
    },
    // 裁决：每夜最多几次模型调用、最多改几条事实卡。
    "dream": {
      "enabled": true,
      "titlePrefix": "[fact] ",
      "maxLlmCalls": 60,
      "maxUpdates": 20,
      "grouping": { "searchTopK": 5, "queryChars": 120, "sameRootScore": 0.5, "crossRootScore": 0.6, "maxCluster": 5 }
    },
    // 画像：写哪个文件、统计文件在哪（相对本配置文件所在目录）。
    "profile": { "enabled": true, "path": "data/profile.json", "statsPath": "data/profile-stats.json" },
    // 蒸馏/裁决走哪个模型：WeKnora 自带网关，不用第二把密钥。
    "llm": { "mode": "weknora-session-chat", "modelName": "builtin-deepseek-flash", "timeoutMs": 240000 },
    // 计划任务的时间：hourly 表示每小时一次；其余写 HH:MM。
    "tasks": { "ingest": "hourly", "distill": "00:00", "dream": "00:30" }
  },

  // ── 9. 其它 ────────────────────────────────────────────────────────
  // 侧边栏记忆面板：看这轮注入了什么、改了哪些卡。
  "panelEnabled": true,
  // 日志相对本文件所在目录；注入命中、跳过、失败都记在这里。
  "logFile": "logs/inject.log"
}
`;
