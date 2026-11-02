/**
 * Sidebar panel for the WeKnora memory layer: read and edit the standing cards, and look
 * at what the injector actually did. Loaded by the DSH web GUI through its module loader,
 * so the file is a plain factory -- no bundler, no JSX, react comes from require().
 *
 * No hooks: the shell renders a slot contribution through a plain function call, where a
 * hook answers "Invalid hook call" (React error #321). State lives in a module store and
 * reaches React through a class component's lifecycle.
 *
 * The API is two exact routes on the GUI's own /api transport (see lib/panel.js): same
 * origin, the browser session rides along, no port constant, no CORS.
 */
window.__ModuleLoader__.load({
  id: "@rennimars/dsh-weknora-memory",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const CSS = "/* Scoped to the panel root so nothing leaks into the GUI; every colour rides the --dsw-* tokens,\n   so the panel follows the active theme (light/dark/skins) exactly as the task board does. */\n[data-wk-memory]{--wk-radius:8px;--wk-control-h:28px;--wk-gap:12px;display:flex;flex-direction:column;box-sizing:border-box;width:100%;height:100%;min-width:0;min-height:0;gap:var(--wk-gap);padding:14px 16px 16px;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px;line-height:20px}\n[data-wk-memory] *{box-sizing:border-box}\n[data-wk-memory] .wk-head{display:flex;align-items:flex-start;gap:10px;flex:none}\n[data-wk-memory] .wk-headText{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}\n[data-wk-memory] .wk-title{font-size:15px;font-weight:600;line-height:22px}\n[data-wk-memory] .wk-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n[data-wk-memory] .wk-tools{display:flex;align-items:center;gap:8px;flex:none}\n[data-wk-memory] .wk-tabs{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:var(--wk-radius);background:var(--dsw-alias-bg-layer-2);flex:none}\n[data-wk-memory] .wk-tab{height:24px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;transition:background 120ms ease,color 120ms ease}\n[data-wk-memory] .wk-tab:hover{color:var(--dsw-alias-label-primary)}\n[data-wk-memory] .wk-tab[data-on=\"1\"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv1);font-weight:600}\n[data-wk-memory] .wk-btn{display:inline-flex;align-items:center;gap:4px;height:var(--wk-control-h);padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--wk-radius);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;transition:background 120ms ease,color 120ms ease,border-color 120ms ease;white-space:nowrap}\n[data-wk-memory] .wk-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}\n[data-wk-memory] .wk-btn:disabled{opacity:.5;cursor:default}\n[data-wk-memory] .wk-btn[data-tone=\"primary\"]{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}\n[data-wk-memory] .wk-btn[data-tone=\"primary\"]:hover{background:var(--dsw-alias-button-primary-hover)}\n[data-wk-memory] .wk-btn[data-tone=\"danger\"]:hover{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}\n[data-wk-memory] .wk-body{display:flex;flex-direction:column;gap:12px;flex:1 1 auto;min-height:0}\n[data-wk-memory] .wk-section{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-surface-raised)}\n[data-wk-memory] .wk-sectionHead{display:flex;align-items:center;gap:8px;min-width:0}\n[data-wk-memory] .wk-sectionTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}\n[data-wk-memory] .wk-sectionNote{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-left:auto;font-variant-numeric:tabular-nums}\n[data-wk-memory] .wk-bar{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}\n[data-wk-memory] .wk-barFill{height:100%;border-radius:2px;background:var(--dsw-alias-state-business-primary);transition:width 160ms ease}\n[data-wk-memory] .wk-barFill[data-over=\"1\"]{background:var(--dsw-alias-state-error-primary)}\n[data-wk-memory] .wk-list{display:flex;flex-direction:column;gap:8px}\n[data-wk-memory] .wk-card{display:grid;grid-template-columns:3px minmax(0,1fr);gap:0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-surface-raised);overflow:hidden;transition:border-color 120ms ease}\n[data-wk-memory] .wk-card:hover{border-color:var(--dsw-alias-border-l2)}\n[data-wk-memory] .wk-stripe{background:var(--wk-stripe,var(--dsw-alias-border-l3))}\n[data-wk-memory] .wk-cardBody{display:flex;flex-direction:column;gap:6px;padding:10px 12px;min-width:0}\n[data-wk-memory] .wk-cardMeta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}\n[data-wk-memory] .wk-cardText{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);word-break:break-word}\n[data-wk-memory] .wk-cardActions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}\n[data-wk-memory] .wk-chip{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:999px;font-size:11px;line-height:18px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}\n[data-wk-memory] .wk-chip[data-tone=\"ok\"]{color:var(--dsw-alias-state-success-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-success-primary)}\n[data-wk-memory] .wk-chip[data-tone=\"warn\"]{color:var(--dsw-alias-state-warn-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-warn-primary)}\n[data-wk-memory] .wk-chip[data-tone=\"err\"]{color:var(--dsw-alias-state-error-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-error-primary)}\n[data-wk-memory] .wk-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}\n[data-wk-memory] .wk-metric{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-surface-raised)}\n[data-wk-memory] .wk-metricLabel{font-size:12px;color:var(--dsw-alias-label-tertiary)}\n[data-wk-memory] .wk-metricValue{font-size:20px;line-height:26px;font-weight:600;font-variant-numeric:tabular-nums}\n[data-wk-memory] .wk-metricNote{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}\n[data-wk-memory] .wk-table{display:flex;flex-direction:column;gap:0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden}\n[data-wk-memory] .wk-tr{display:grid;grid-template-columns:minmax(0,1fr) 72px 72px;gap:8px;align-items:center;padding:7px 12px;font-size:12px;line-height:18px;border-top:1px solid var(--dsw-alias-separator-primary)}\n[data-wk-memory] .wk-tr:first-child{border-top:0}\n[data-wk-memory] .wk-tr[data-head=\"1\"]{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-surface-raised);font-size:11px}\n[data-wk-memory] .wk-num{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}\n[data-wk-memory] .wk-cell{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n[data-wk-memory] .wk-textarea{width:100%;min-height:64px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--wk-radius);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;resize:vertical}\n[data-wk-memory] .wk-textarea:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}\n[data-wk-memory] .wk-select{height:var(--wk-control-h);padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--wk-radius);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}\n[data-wk-memory] .wk-formRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}\n[data-wk-memory] .wk-empty{padding:24px 0;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px}\n[data-wk-memory] .wk-err{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;background:var(--dsw-alias-surface-raised);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}\n[data-wk-memory] .wk-inlineErr{font-size:12px;color:var(--dsw-alias-state-error-primary)}\n[data-wk-memory] .wk-muted{color:var(--dsw-alias-label-tertiary)}\n[data-wk-memory] .wk-icon{display:flex;align-items:center;justify-content:center;width:18px;height:18px;color:currentColor}";

    const React = require("react");
    const el = React.createElement;

    /**
     * Document-relative on purpose. The GUI page carries <base href="./">, so a leading slash
     * would escape the entry directory in a sub-path deployment. These are the two exact paths
     * the host registered on the GUI's own /api transport, which carries the browser session.
     */
    const API = "api/weknora-memory/";
    const TIMEOUT_MS = 15000;

    const KIND = {
      soul: { label: "行为准则", color: "var(--dsw-alias-state-business-primary)" },
      user: { label: "用户画像", color: "var(--dsw-alias-state-success-primary)" },
      agent: { label: "工作习惯", color: "var(--dsw-alias-state-warn-primary)" },
    };
    const KIND_ORDER = ["soul", "user", "agent"];
    const STATUS_LABEL = { active: "生效", proposed: "待确认", disputed: "有争议" };
    const STATUS_TONE = { active: "ok", proposed: "warn", disputed: "err" };
    const TABS = [["cards", "记忆卡"], ["memory", "记忆统计"], ["retrieval", "检索统计"]];

    function ensureStyles() {
      try {
        if (document.querySelector("style[data-wk-memory-style]")) return;
        const style = document.createElement("style");
        style.setAttribute("data-wk-memory-style", "1");
        style.textContent = CSS;
        document.head.appendChild(style);
      } catch {}
    }

    /** One call with a deadline and a readable failure class -- never a raw fetch error. */
    async function call(path, init) {
      const controller = new AbortController();
      const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
      const options = Object.assign({}, init || {});
      options.signal = controller.signal;
      options.credentials = "same-origin";
      options.headers = Object.assign({ accept: "application/json" }, (init && init.headers) || {});
      if (options.body !== undefined) options.headers["content-type"] = "application/json";
      try {
        const res = await fetch(API + path, options);
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch {}
        if (res.status === 401) throw new Error("宿主说没有权限（HTTP 401）：面板路由没挂上，或浏览器会话已过期——刷新页面再试");
        if (res.status === 403) throw new Error("宿主拒绝了这个请求（HTTP 403）：来源校验没过，请从 GUI 页面本身打开");
        if (!data) throw new Error("宿主返回了非 JSON 内容（HTTP " + res.status + "，" + text.slice(0, 60) + "）");
        if (res.status >= 400 || data.ok === false) throw new Error((data.error || "HTTP " + res.status) + "（HTTP " + res.status + "）");
        return data;
      } catch (error) {
        if (error && error.name === "AbortError") throw new Error("请求超时（" + TIMEOUT_MS + "ms）");
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    /**
     * Panel state lives here, outside React, and is pushed to the mounted view by
     * subscription. The shell hands slots a plain render function, and a hook call in that
     * position answers "Invalid hook call" (React error #321) -- so the whole panel keeps its
     * state in this store and renders from it, with no hooks anywhere.
     */
    const store = {
      state: { loading: true, data: null, error: "", tab: "cards", busy: false, problem: "", editing: "", draft: "" },
      listeners: new Set(),
      started: false,
      subscribe(listener) {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
      },
      set(patch) {
        this.state = Object.assign({}, this.state, patch);
        for (const listener of Array.from(this.listeners)) {
          try { listener(this.state); } catch {}
        }
      },
      start() {
        if (this.started) return;
        this.started = true;
        this.reload();
      },
      reload() {
        this.set({ loading: true, error: "" });
        call("state").then(
          (data) => this.set({ loading: false, data: data, error: "" }),
          (error) => this.set({ loading: false, data: null, error: String((error && error.message) || error) })
        );
      },
      mutate(payload) {
        this.set({ busy: true, problem: "" });
        call("card", { method: "POST", body: JSON.stringify(payload) }).then(
          (data) => this.set({ busy: false, data: data, editing: "", draft: "" }),
          (error) => this.set({ busy: false, problem: String((error && error.message) || error) })
        );
      },
    };

    /** Mounts the store into React through the class lifecycle -- no hooks involved. */
    class PanelRoot extends React.Component {
      constructor(props) {
        super(props);
        this.state = store.state;
        this.failed = null;
      }
      componentDidMount() {
        this.unsubscribe = store.subscribe((state) => this.setState(state));
        this.setState(store.state);
        store.start();
      }
      componentWillUnmount() {
        if (this.unsubscribe) this.unsubscribe();
      }
      static getDerivedStateFromError(error) {
        return { crash: String((error && (error.stack || error.message)) || error) };
      }
      render() {
        if (this.state.crash) {
          return el("div", { style: { padding: 16, font: "13px/20px ui-monospace,Consolas,monospace", color: "#ff5d6c" } },
            "记忆面板渲染失败：" + this.state.crash);
        }
        return el(Panel, { state: this.state });
      }
    }

    function Metric(props) {
      return el("div", { className: "wk-metric" },
        el("div", { className: "wk-metricLabel" }, props.label),
        el("div", { className: "wk-metricValue" }, props.value),
        props.note ? el("div", { className: "wk-metricNote" }, props.note) : null);
    }

    function Budget(props) {
      const pct = props.max > 0 ? Math.min(100, Math.round((props.used / props.max) * 100)) : 0;
      return el("div", { className: "wk-section" },
        el("div", { className: "wk-sectionHead" },
          el("span", { className: "wk-sectionTitle" }, props.title),
          el("span", { className: "wk-sectionNote" }, props.note)),
        el("div", { className: "wk-bar" },
          el("div", { className: "wk-barFill", "data-over": props.used > props.max ? "1" : "0", style: { width: pct + "%" } })));
    }

    function CardRow(props) {
      const card = props.card;
      const kind = KIND[card.kind] || KIND.user;
      const editing = props.state.editing === card.id;
      const busy = props.state.busy;
      const actions = editing
        ? [
            el("button", { key: "s", className: "wk-btn", "data-tone": "primary", disabled: busy,
              onClick: () => store.mutate({ op: "update", id: card.id, patch: { text: props.state.draft } }) }, "保存"),
            el("button", { key: "c", className: "wk-btn", disabled: busy,
              onClick: () => store.set({ editing: "", draft: "" }) }, "取消"),
          ]
        : [
            el("button", { key: "e", className: "wk-btn",
              onClick: () => store.set({ editing: card.id, draft: card.text }) }, "编辑"),
            card.status === "active"
              ? el("button", { key: "d", className: "wk-btn", disabled: busy,
                  onClick: () => store.mutate({ op: "update", id: card.id, patch: { status: "proposed" } }) }, "停用")
              : el("button", { key: "a", className: "wk-btn", disabled: busy,
                  onClick: () => store.mutate({ op: "update", id: card.id, patch: { status: "active" } }) }, "启用"),
            el("button", { key: "x", className: "wk-btn", "data-tone": "danger", disabled: busy,
              onClick: () => store.mutate({ op: "remove", id: card.id }) }, "删除"),
          ];
      return el("div", { className: "wk-card", style: { "--wk-stripe": kind.color } },
        el("div", { className: "wk-stripe" }),
        el("div", { className: "wk-cardBody" },
          el("div", { className: "wk-cardMeta" },
            el("span", { className: "wk-chip" }, kind.label),
            el("span", { className: "wk-chip", "data-tone": STATUS_TONE[card.status] || "" }, STATUS_LABEL[card.status] || card.status),
            card.core ? el("span", { className: "wk-chip" }, "核心") : null,
            card.rendered ? el("span", { className: "wk-chip", "data-tone": "ok" }, "已注入") : el("span", { className: "wk-chip" }, "未注入"),
            el("span", { className: "wk-num" }, card.chars + " 字"),
            el("span", { className: "wk-cell wk-muted" }, card.id)),
          editing
            ? el("textarea", { className: "wk-textarea", value: props.state.draft,
                onChange: (event) => store.set({ draft: event.target.value }) })
            : el("div", { className: "wk-cardText" }, card.text),
          el("div", { className: "wk-cardActions" }, actions)));
    }

    function AddCard(props) {
      const busy = props.state.busy;
      return el("div", { className: "wk-section" },
        el("div", { className: "wk-sectionHead" }, el("span", { className: "wk-sectionTitle" }, "新增一张卡")),
        el("div", { className: "wk-formRow" },
          el("select", { className: "wk-select", value: props.state.newKind || "user",
            onChange: (event) => store.set({ newKind: event.target.value }) },
            KIND_ORDER.map((key) => el("option", { key: key, value: key }, KIND[key].label))),
          el("button", { className: "wk-btn", "data-tone": "primary", disabled: busy,
            onClick: () => {
              const text = (props.state.newText || "").trim();
              if (!text) return;
              store.mutate({ op: "add", input: { kind: props.state.newKind || "user", text: text } });
              store.set({ newText: "" });
            } }, "添加")),
        el("textarea", { className: "wk-textarea", placeholder: "一句话，写清要记住的规则或事实", value: props.state.newText || "",
          onChange: (event) => store.set({ newText: event.target.value }) }),
        el("div", { className: "wk-cardMeta" }, "新增的卡是 proposed 状态，不会被注入；先点「启用」或等夜间评审放行。"));
    }

    function CardsTab(props) {
      const data = props.data.profile;
      // caps.chars is the per-kind character budget the renderer enforces; dropped is a map of
      // gate name to count (not a list of card ids), so both are read as the host sends them.
      const caps = data.caps.chars;
      const dropped = data.rendered.dropped || {};
      const droppedTotal = Object.keys(dropped).reduce((sum, key) => sum + (Number(dropped[key]) || 0), 0);
      const droppedNote = Object.keys(dropped).filter((key) => dropped[key]).map((key) => key + " " + dropped[key]).join(" · ") || "全部命中";
      const byKind = { soul: [], user: [], agent: [] };
      for (const card of data.cards) (byKind[card.kind] || byKind.user).push(card);
      const groups = KIND_ORDER.filter((key) => byKind[key].length > 0);
      return el("div", { className: "wk-body" },
        el("div", { className: "wk-grid" },
          el(Metric, { label: "本轮注入", value: data.rendered.chosen + " 张", note: "另 " + data.rendered.soulCards + " 张准则" }),
          el(Metric, { label: "卡片总数", value: data.cards.length, note: "user " + data.spent.user + "/" + caps.user + " 字" }),
          el(Metric, { label: "未注入", value: droppedTotal, note: droppedNote })),
        el(Budget, { title: "用户画像", used: data.spent.user, max: caps.user, note: data.spent.user + " / " + caps.user + " 字" }),
        el(Budget, { title: "工作习惯", used: data.spent.agent, max: caps.agent, note: data.spent.agent + " / " + caps.agent + " 字" }),
        el(Budget, { title: "行为准则", used: data.spent.soul, max: data.soulCaps.maxChars, note: data.spent.soul + " / " + data.soulCaps.maxChars + " 字" }),
        groups.length
          ? groups.map((key) => el("div", { key: key, className: "wk-section" },
              el("div", { className: "wk-sectionHead" },
                el("span", { className: "wk-sectionTitle" }, KIND[key].label),
                el("span", { className: "wk-sectionNote" }, byKind[key].length + " 张")),
              el("div", { className: "wk-list" }, byKind[key].map((card) =>
                el(CardRow, { key: card.id, card: card, state: props.state })))))
          : el("div", { className: "wk-empty" }, "还没有卡。夜间任务会写入，也可以在这里手动加一张。"),
        el(AddCard, { state: props.state }));
    }

    function MemoryTab(props) {
      const data = props.data.memory;
      const rows = data.perCard.slice(0, 40);
      return el("div", { className: "wk-body" },
        el("div", { className: "wk-grid" },
          el(Metric, { label: "卡片", value: data.cards, note: "user " + data.byKind.user + " · agent " + data.byKind.agent + " · soul " + data.byKind.soul }),
          el(Metric, { label: "生效中", value: data.byStatus.active, note: "待确认 " + data.byStatus.proposed + " · 争议 " + data.byStatus.disputed }),
          el(Metric, { label: "注入率", value: props.data.profile.rendered.chosen + "/" + data.cards, note: "按当前预算实际进入提示词" })),
        el("div", { className: "wk-section" },
          el("div", { className: "wk-sectionHead" },
            el("span", { className: "wk-sectionTitle" }, "按命中排序"),
            el("span", { className: "wk-sectionNote" }, rows.length + " / " + data.perCard.length)),
          rows.length
            ? el("div", { className: "wk-table" },
                el("div", { className: "wk-tr", "data-head": "1" },
                  el("span", { className: "wk-cell" }, "卡片"), el("span", { className: "wk-num" }, "轮次"), el("span", { className: "wk-num" }, "命中")),
                rows.map((row) => el("div", { key: row.id, className: "wk-tr" },
                  el("span", { className: "wk-cell", title: row.id }, row.id),
                  el("span", { className: "wk-num" }, row.rounds),
                  el("span", { className: "wk-num" }, row.hits))))
            : el("div", { className: "wk-empty" }, "统计文件还没写：夜间任务跑一次后才有数据。")));
    }

    function RetrievalTab(props) {
      const data = props.data.retrieval;
      const kbs = Object.keys(data.kb_hits || {});
      return el("div", { className: "wk-body" },
        el("div", { className: "wk-grid" },
          el(Metric, { label: "注入率", value: data.injected_pct + "%", note: data.injected + " 轮注入 · " + data.pinned_only + " 轮只有常驻块" }),
          el(Metric, { label: "平均命中", value: data.avg_hits, note: "每轮进入检索块的片段数" }),
          el(Metric, { label: "平均字符", value: data.avg_retrieval_chars, note: "常驻块 " + data.avg_pinned_chars + " 字" }),
          el(Metric, { label: "耗时 p50 / p95", value: data.p50_ms + " / " + data.p95_ms, note: "毫秒" }),
          el(Metric, { label: "记录轮数", value: data.records, note: "最近 1000 条日志" }),
          el(Metric, { label: "退役 / 归并", value: data.retired_dropped + " / " + data.dropped_siblings, note: "被丢弃的事实条目" })),
        el("div", { className: "wk-section" },
          el("div", { className: "wk-sectionHead" }, el("span", { className: "wk-sectionTitle" }, "每库贡献")),
          kbs.length
            ? el("div", { className: "wk-table" }, kbs.map((label) => el("div", { key: label, className: "wk-tr" },
                el("span", { className: "wk-cell" }, label),
                el("span", { className: "wk-num" }, data.kb_hits[label] + " 命中"),
                el("span", { className: "wk-num" }, ""))))
            : el("div", { className: "wk-empty" }, "暂无命中记录")));
    }

    /** The whole panel: a pure function of the store snapshot. No hooks anywhere. */
    function Panel(props) {
      const state = props.state;
      const active = state.tab;
      let content;
      if (state.error) {
        content = el("div", { className: "wk-err" },
          el("div", null, state.error),
          el("div", { className: "wk-formRow" },
            el("button", { className: "wk-btn", onClick: () => store.reload() }, "重试")));
      } else if (!state.data) {
        content = el("div", { className: "wk-empty" }, "读取中…");
      } else if (active === "cards") {
        content = el(CardsTab, { data: state.data, state: state });
      } else if (active === "memory") {
        content = el(MemoryTab, { data: state.data });
      } else {
        content = el(RetrievalTab, { data: state.data });
      }
      return el("div", { "data-wk-memory": "1" },
        el("div", { className: "wk-head" },
          el("div", { className: "wk-headText" },
            el("div", { className: "wk-title" }, "记忆"),
            el("div", { className: "wk-sub" }, "常驻块与画像卡：改这里等于改下一轮注入的内容")),
          el("div", { className: "wk-tools" },
            el("button", { className: "wk-btn", disabled: state.loading || state.busy, onClick: () => store.reload() },
              state.loading ? "刷新中…" : "刷新"),
            el("div", { className: "wk-tabs" }, TABS.map((pair) =>
              el("button", {
                key: pair[0],
                className: "wk-tab",
                "data-on": active === pair[0] ? "1" : "0",
                onClick: () => store.set({ tab: pair[0] }),
              }, pair[1]))))),
        state.problem ? el("div", { className: "wk-err" }, state.problem) : null,
        content);
    }

    function Page() {
      ensureStyles();
      return el(PanelRoot, null);
    }

    function Row() {
      return el("span", { className: "wk-icon", title: "记忆" },
        el("svg", { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" },
          el("rect", { x: 3.5, y: 5, width: 17, height: 14, rx: 3 }),
          el("path", { d: "M7.5 10h5M7.5 14h8" }),
          el("path", { d: "M16.5 10h.01" })));
    }

    const inject = ["slots"];

    function apply(ctx) {
      try {
        ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name: "sidebar.panellist", id: "weknora-memory", order: 60, label: () => "记忆" }, Row));
        ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: "weknora-memory", inject: () => ({}) }, Page));
      } catch (error) {
        // A shell that does not declare these seats simply has no panel here.
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;

  }
});
