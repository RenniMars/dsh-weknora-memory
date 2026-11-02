/**
 * The slot panel renders inside the GUI, where nothing here can run it. This loads the real
 * client bundle into a stub React and renders every tab against a snapshot the host really
 * produces, so a client that reads a field the host does not send fails here instead of
 * turning the panel into an error box.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { panelSnapshot } from "../lib/panel.js";

function loadClient() {
  const captured = [];
  const React = {
    createElement: (type, props, ...kids) => ({ type, props: props || {}, kids }),
    Component: class {
      constructor(props) { this.props = props || {}; this.state = {}; }
      setState(patch) { this.state = Object.assign({}, this.state, typeof patch === "function" ? patch(this.state) : patch); }
    },
  };
  const context = vm.createContext({
    console,
    require: (name) => (name === "react" ? React : (() => { throw new Error("unexpected require " + name); })()),
    document: { querySelector: () => null, createElement: () => ({ setAttribute() {}, textContent: "" }), head: { appendChild() {} }, body: { appendChild() {} } },
    window: { __ModuleLoader__: { load: (def) => captured.push(def) } },
    setTimeout,
    clearTimeout,
  });
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  vm.runInContext(source, context, { filename: "client.js" });
  assert.equal(captured.length, 1, "the bundle registers exactly one module");
  return captured[0].factory(context.require);
}

/**
 * Flatten a stubbed tree into its text, so an assertion can read what the user would see.
 * A function component in the stub is just a value, so it is invoked here (a class component
 * is not: it has to be mounted, and every class in this bundle only wraps the store).
 */
function textOf(node, depth = 0) {
  if (depth > 40 || node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((child) => textOf(child, depth + 1)).join("");
  const type = node.type;
  if (typeof type === "function" && !(type.prototype && type.prototype.render)) {
    return textOf(type(node.props), depth + 1);
  }
  return textOf(node.kids, depth + 1);
}

test("R9: every panel tab renders from the snapshot the host really sends", () => {
  const dir = mkdtempSync(join(tmpdir(), "wk-client-"));
  const profilePath = join(dir, "profile.json");
  writeFileSync(profilePath, JSON.stringify({
    version: 1,
    cards: [
      { id: "user.cost", kind: "user", text: "在意成本。", status: "active", core: true, attest: 0 },
      { id: "agent.grep", kind: "agent", text: "改代码前先 grep。", status: "proposed", core: true, attest: 0 },
      { id: "soul.line", kind: "soul", text: "结论必须可追溯到行号。", status: "active", core: true, attest: 0 },
    ],
  }, null, 2));
  // Only the fields profileCaps reads; the shipped defaults fill the rest, so this test sees
  // the same caps tuple the real config produces (200 / 400 characters).
  const config = { profile: { enabled: true, path: profilePath, soulMaxCards: 6, soulMaxChars: 300 } };
  const snapshot = panelSnapshot({ config, profilePath, statsPath: join(dir, "stats.json"), logFile: join(dir, "inject.log") });
  assert.equal(snapshot.profile.cards.length, 3);

  const mod = loadClient();
  assert.equal(mod.inject.length, 1, "the module injects exactly one service");
  assert.equal(mod.inject[0], "slots", "a cross-realm array cannot be deep-compared, so compare its member");
  const registered = [];
  mod.apply({ slots: { inject: (name, fn) => fn(), register: (spec, component) => registered.push({ key: spec.key ?? spec.id, component }) } });
  assert.equal(registered.length, 2, "the row and the page both register");

  const Page = registered[1].component;
  const rootElement = Page({});
  const store = new rootElement.type({});
  store.state = { loading: false, data: null, error: "", tab: "cards", busy: false, problem: "", editing: "", draft: "", newKind: "user", newText: "" };
  const Panel = store.render().type;

  for (const tab of ["cards", "memory", "retrieval"]) {
    const tree = Panel({ state: Object.assign({}, store.state, { data: snapshot, tab }) });
    const body = tree.kids[2];
    assert.ok(body && typeof body.type === "function", tab + " renders a tab body");
    const inner = body.type(body.props);
    assert.ok(textOf(inner).length > 0, tab + " renders visible text");
  }

  const cards = Panel({ state: Object.assign({}, store.state, { data: snapshot, tab: "cards" }) });
  const cardsText = textOf(cards);
  assert.match(cardsText, /行为准则/);
  assert.match(cardsText, /在意成本/);
  assert.match(cardsText, /82|0/, "the budget numbers come from the snapshot");

  const broken = Panel({ state: Object.assign({}, store.state, { data: null, error: "宿主说没有权限（HTTP 401）" }) });
  assert.match(textOf(broken), /HTTP 401/);
});
