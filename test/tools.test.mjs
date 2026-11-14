import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { loadConfig } from "../lib/config.js";
import { mountTools, rawToolsConfig } from "../lib/mount-tools.js";
import { resolveConfig } from "../lib/tool-config.js";
import { createTools } from "../lib/tools.js";

const configOf = (overrides = {}) => loadConfig({ logFile: "logs/tools-test.log", pinned: [], profile: { enabled: false }, decay: { statePath: "data/tools-test-state.json" }, ...overrides });

/** Collect what a scope would have registered, and let the test drive one tool by name. */
function mountOn(cfg) {
  const registered = [];
  const result = mountTools({ tools: { register: (definition) => registered.push(definition) } }, cfg);
  assert.deepEqual(result.mounted, registered.map((entry) => entry.name));
  assert.deepEqual(result.failed, []);
  return { registered, tool: (suffix) => registered.find((entry) => entry.name === `${cfg.toolPrefix}_${suffix}`) };
}

test("our config maps onto the vendor config the tools expect", () => {
  const cfg = configOf({ apiUrl: "http://localhost:8080/api/v1", apiKey: "k-1", kbIds: ["kb-1", "kb-2"], toolAgentId: "", toolPrefix: "weknora", toolMaxResults: 5 });
  const raw = rawToolsConfig(cfg);
  assert.equal(raw.baseUrl, "http://localhost:8080/api/v1");
  assert.equal(raw.apiKey, "k-1");
  assert.deepEqual(raw.knowledgeBaseIds, ["kb-1", "kb-2"]);
  assert.equal(raw.agentId, undefined, "an empty toolAgentId must stay RAG, not agent");
  assert.equal(raw.maxResults, 5);
  const resolved = resolveConfig(raw);
  assert.equal(resolved.baseUrl, "http://localhost:8080/api/v1");
  assert.equal(resolved.toolPrefix, "weknora");
});

test("mounting registers the four tools, and a switched-off tool is never registered", () => {
  const all = mountOn(configOf({}));
  assert.deepEqual(all.registered.map((entry) => entry.name), [
    "weknora_list_knowledge_bases",
    "weknora_search",
    "weknora_read_document",
    "weknora_ask",
  ]);
  const narrowed = mountOn(configOf({ tools: { ask: false, readDocument: false } , toolPrefix: "mem" }));
  assert.deepEqual(narrowed.registered.map((entry) => entry.name), ["mem_list_knowledge_bases", "mem_search"]);
  const off = mountOn(configOf({ toolsEnabled: false }));
  assert.equal(off.registered.length, 0, "a switched-off deployment must register nothing, even when mounted directly");
});

test("the search tool projects passages and renders them for the model", async () => {
  const resolved = resolveConfig({ baseUrl: "http://127.0.0.1:1/api/v1", toolPrefix: "weknora", knowledgeBaseIds: ["kb-1"] });
  const client = {
    search: async () => [{ id: "chunk-1", knowledge_id: "doc-1", knowledge_title: "注入机制", chunk_index: 2, score: 0.8123, content: "pre-step 钩子每轮注入" }],
    findDocuments: async () => [],
  };
  const tool = createTools(client, resolved).find((entry) => entry.name === "weknora_search");
  const value = await tool.execute({ query: "注入" }, { signal: new AbortController().signal });
  assert.equal(value.count, 1);
  assert.equal(value.results[0].document, "注入机制");
  assert.equal(value.results[0].score, 0.8123);
  assert.equal(typeof value.results[0].content, "string");
  const rendered = tool.output.render({ query: "注入" }, value).map((part) => part.text).join("");
  assert.match(rendered, /注入机制/);
});

test("the ask tool reads the SSE stream end to end, on both pipelines", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.method + " " + req.url);
    if (req.method === "POST" && req.url.endsWith("/sessions")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { id: "session-1" } }));
      return;
    }
    if (req.method === "POST" && (req.url.includes("/knowledge-chat/") || req.url.includes("/agent-chat/"))) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event) => res.write("data: " + JSON.stringify(event) + "\n\n");
      send({ response_type: "answer", content: "答案是" });
      send({ response_type: "answer", content: "四十二" });
      send({ response_type: "references", knowledge_references: [{ knowledge_id: "doc-1", knowledge_title: "注入机制", chunk_index: 1, content: "片段" }] });
      send({ response_type: "tool_call", tool_calls: [{ function: { name: "grep_docs" } }] });
      send({ response_type: "complete" });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
  try {
    const rag = createTools(Object.assign(
      new (await import("../lib/tools-client.js")).WeknoraClient(resolveConfig({ baseUrl, toolPrefix: "weknora", knowledgeBaseIds: ["kb-1"] })),
    ), resolveConfig({ baseUrl, toolPrefix: "weknora", knowledgeBaseIds: ["kb-1"] })).find((entry) => entry.name === "weknora_ask");
    const ragValue = await rag.execute({ query: "生命的意义" }, { signal: new AbortController().signal });
    assert.equal(ragValue.answer, "答案是四十二");
    assert.equal(ragValue.pipeline, "rag");
    assert.equal(ragValue.session_id, "session-1");
    assert.deepEqual(ragValue.tool_calls, ["grep_docs"]);
    assert.equal(ragValue.references[0].document, "注入机制");

    const agentResolved = resolveConfig({ baseUrl, toolPrefix: "weknora", agentId: "agent-9" });
    const agent = createTools(new (await import("../lib/tools-client.js")).WeknoraClient(agentResolved), agentResolved).find((entry) => entry.name === "weknora_ask");
    const agentValue = await agent.execute({ query: "继续问" }, { signal: new AbortController().signal });
    assert.equal(agentValue.pipeline, "agent");
    assert.ok(seen.some((line) => line.includes("/agent-chat/")), "an agent id must route to the ReAct endpoint");
    assert.ok(seen.some((line) => line.includes("/knowledge-chat/")), "no agent id must route to the RAG endpoint");
  } finally {
    server.close();
  }
});
