// Cue web UI. Plain JS, no build step.
// Email content is untrusted: everything is rendered with textContent via h().

const app = document.getElementById("app");
const drafts = new Map(); // actionId -> edited text, survives re-renders

const LANES = [
  { key: "needs_you", cls: "needs", title: "Needs you", desc: "Decisions and replies that need your judgment." },
  { key: "cue_on_it", cls: "working", title: "Cue is on it", desc: "Things Cue is doing for you right now." },
  { key: "waiting", cls: "waiting", title: "Waiting", desc: "Someone owes you a reply." },
  { key: "taken_care_of", cls: "done", title: "Taken care of", desc: "Routine mail, filed or handled." },
];
const KIND_LABEL = { doc: "Drive file", event: "Calendar", message: "Email" };

/** Tiny hyperscript: h("div", { class: "x", onclick }, child, "text", ...) */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(path, body) {
  const res = await fetch(`/api${path}`, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

const ago = (iso, now) => {
  const d = (Date.parse(now) - Date.parse(iso)) / 86_400_000;
  if (d < 1 / 24) return "just now";
  if (d < 1) return `${Math.round(d * 24)}h ago`;
  if (d < 30) return `${Math.floor(d)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

// ---------------------------------------------------------------------------
// Chrome: accounts, metric, drawer

let lastHome = null;

function renderChrome(home) {
  document.getElementById("accounts").replaceChildren(...home.accounts.map((a) => h("span", { class: "chip", title: a.address }, a.label)));
  document.getElementById("metric").replaceChildren(h("b", {}, home.metrics.appSearchesSaved), " searches saved");
  document.getElementById("brain").textContent = home.brain === "claude" ? "Claude" : "Offline mode";
  document.getElementById("brain").title = home.brain === "claude"
    ? "Summaries and drafts are written by Claude"
    : "No API key: summaries and drafts use built-in templates";

  document.getElementById("rules").replaceChildren(...home.rules.map((r) =>
    h("label", { class: "rule" },
      h("input", {
        type: "checkbox", checked: r.enabled,
        onchange: async (e) => { await api(`/rules/${r.id}`, { enabled: e.target.checked }); refresh(); },
      }),
      h("span", {}, r.label))));

  document.getElementById("reminders").replaceChildren(...(home.reminders.length
    ? home.reminders.map((r) => h("li", {}, `${new Date(r.at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}: ${r.note}`))
    : [h("li", { class: "muted" }, "No reminders yet.")]));

  document.getElementById("audit").replaceChildren(...(home.audit.length
    ? home.audit.map((a) => h("li", {}, a.text, h("div", { class: "who" }, a.by === "you" ? "by you" : `automatically (${a.by.replace("rule:", "rule: ")})`)))
    : [h("li", { class: "muted" }, "Nothing yet.")]));
}

const drawer = document.getElementById("drawer");
document.getElementById("open-drawer").onclick = () => { drawer.hidden = false; };
document.getElementById("close-drawer").onclick = () => { drawer.hidden = true; };
document.addEventListener("keydown", (e) => { if (e.key === "Escape") drawer.hidden = true; });

// ---------------------------------------------------------------------------
// Home

function renderHome(home) {
  const now = home.now;
  const needs = home.lanes.needs_you.length;
  app.replaceChildren(
    h("div", { class: "greeting" },
      h("h1", {}, needs ? `${needs} thing${needs === 1 ? "" : "s"} need${needs === 1 ? "s" : ""} you today` : "You're all caught up"),
      h("p", {}, `Across ${home.accounts.length} connected accounts. Everything else is handled, in progress, or waiting on someone.`)),
    h("div", { class: "lanes" }, LANES.map((lane) => {
      const cards = home.lanes[lane.key];
      return h("section", { class: `lane ${lane.cls}`, "aria-label": lane.title },
        h("div", { class: "lane-head" }, h("h2", {}, lane.title), h("span", { class: "count" }, cards.length)),
        h("p", { class: "lane-desc" }, lane.desc),
        cards.length ? cards.map((c) => card(c, lane, now)) : h("div", { class: "empty" }, "Nothing here."));
    })),
  );
}

function card(c, lane, now) {
  const badgeText = c.reason ?? c.note;
  return h("a", { class: "card", href: `#/t/${encodeURIComponent(c.threadId)}` },
    h("div", { class: "card-top" }, h("span", { class: "card-from" }, c.from), h("span", {}, ago(c.when, now))),
    h("div", { class: "card-subject" }, c.subject),
    h("div", { class: "card-summary" }, c.summary),
    badgeText && h("span", { class: "badge" }, lane.key === "cue_on_it" ? h("span", { class: "spinner" }) : null, badgeText));
}

// ---------------------------------------------------------------------------
// Thread

function renderThread(t, now) {
  const focused = document.activeElement?.tagName === "TEXTAREA";
  if (focused) return; // don't yank the draft out from under the user

  const lane = LANES.find((l) => l.key === t.bucket);
  app.replaceChildren(
    h("button", { class: "ghost back", onclick: () => (location.hash = "#/") }, "← All mail"),
    h("div", { class: "thread" },
      h("div", {},
        h("div", { class: "panel" },
          h("div", { class: "eyebrow" }, lane?.title ?? ""),
          h("h1", { class: "thread-title" }, t.subject),
          h("div", { class: "thread-meta" }, `${t.account} · ${t.intents.join(", ").replaceAll("_", " ")}`)),
        h("div", { class: "panel" },
          h("div", { class: "eyebrow" }, "What this needs"),
          h("p", { class: "summary" }, t.analysis.summary),
          t.analysis.whatMatters.length ? h("ul", { class: "matters" }, t.analysis.whatMatters.map((m) => h("li", {}, m))) : null,
          h("div", { class: "by" }, t.analysis.by === "claude" ? "Written by Claude from the thread and the context on the right." : "Built-in summary (offline mode).")),
        t.actions.length ? h("div", { class: "panel" },
          h("div", { class: "eyebrow" }, "Suggested actions"),
          t.actions.map(actionView)) : null,
        h("div", { class: "panel" },
          h("div", { class: "eyebrow" }, `Conversation (${t.messages.length})`),
          t.messages.map((m) => h("div", { class: `message${m.fromMe ? " mine" : ""}` },
            h("div", { class: "message-head" }, h("b", {}, m.from), h("span", {}, ago(m.sentAt, now))),
            h("div", { class: "message-body" }, m.body),
            m.attachments.length ? h("div", { class: "attachment" }, "📎 ", m.attachments.join(", ")) : null)))),
      h("div", {},
        h("div", { class: "panel" },
          h("div", { class: "eyebrow" }, "Found for you"),
          t.context.length
            ? t.context.map(contextView)
            : h("p", { class: "muted" }, "Nothing else in your accounts looks related."),
        ))),
  );
}

function contextView(c) {
  return h("div", { class: "ctx" },
    h("div", { class: "ctx-head" },
      h("span", { class: "ctx-kind" }, KIND_LABEL[c.kind] ?? c.kind),
      c.confidence < 1 ? h("span", { class: "ctx-flag", title: "Cue linked this through a match it isn't fully sure of" }, `${Math.round(c.confidence * 100)}% sure`) : null,
      c.stale ? h("span", { class: "ctx-flag" }, "may be outdated") : null,
      h("span", { class: "ctx-source" }, c.sourceLabel)),
    h("div", { class: "ctx-title" }, c.title),
    c.snippet ? h("div", { class: "ctx-snippet" }, c.snippet) : null,
    h("div", { class: "ctx-path" }, "Found via ", c.path.flatMap((p, i) => (i ? [" → ", h("span", {}, p)] : [h("span", {}, p)]))));
}

function actionView(a) {
  const editable = a.status === "proposed" && typeof a.params.body === "string";
  const attachments = a.params.attachments ?? [];
  const statusText = { proposed: "", running: "Working…", done: "Done", undone: "Undone" }[a.status] ?? a.status;
  const run = (fn) => async () => {
    try { await fn(); drafts.delete(a.id); refresh(); } catch (e) { alert(e.message); }
  };
  return h("div", { class: "action" },
    h("div", { class: "action-head" },
      h("span", { class: "action-label" }, a.label),
      h("span", { class: `risk ${a.risk}`, title: riskHelp(a.risk) }, a.risk === "high" ? "you send" : a.risk === "medium" ? "review" : "safe"),
      a.autoRule ? h("span", { class: "muted", style: "font-size:12px" }, "automatic") : null,
      h("span", { class: "status" }, a.status === "running" ? h("span", { class: "spinner" }) : null, statusText)),
    editable ? h("textarea", {
      "aria-label": "Draft reply",
      oninput: (e) => drafts.set(a.id, e.target.value),
    }, drafts.get(a.id) ?? a.params.body) : null,
    attachments.length ? h("div", { class: "attachment" }, "📎 Attaching ", h("b", {}, attachments.map((x) => x.title).join(", "))) : null,
    a.outcome ? h("div", { class: "outcome" }, "✓ ", a.outcome) : null,
    a.status === "proposed" ? h("div", { class: "buttons" },
      h("button", { class: "primary", onclick: run(() => api(`/actions/${a.id}/approve`, editable ? { body: drafts.get(a.id) ?? a.params.body } : {})) },
        a.kind === "send_reply" || a.kind === "nudge" ? "Send" : "Do it"),
      h("button", { class: "ghost", onclick: run(() => api(`/actions/${a.id}/dismiss`, {})) }, "Not now")) : null,
    a.status === "done" && a.kind !== "send_reply" && a.kind !== "nudge"
      ? h("div", { class: "buttons" }, h("button", { class: "ghost", onclick: run(() => api(`/actions/${a.id}/undo`, {})) }, "Undo"))
      : null);
}

const riskHelp = (r) => ({
  low: "Private and reversible. Can run automatically if you allow it.",
  medium: "Others will see this. Cue drafts it; you approve it.",
  high: "Sends mail. Always waits for you.",
})[r];

// ---------------------------------------------------------------------------
// Router + refresh loop

let lastRender = "";

async function refresh() {
  try {
    const home = await api("/home");
    lastHome = home;
    renderChrome(home);
    const m = location.hash.match(/^#\/t\/(.+)$/);
    if (m) {
      const t = await api(`/threads/${m[1]}`);
      const key = JSON.stringify(t);
      if (key !== lastRender) { renderThread(t, home.now); lastRender = key; }
    } else {
      const key = JSON.stringify(home.lanes);
      if (key !== lastRender) { renderHome(home); lastRender = key; }
    }
  } catch (e) {
    app.replaceChildren(h("p", { class: "muted" }, `Couldn't reach Cue: ${e.message}`));
  }
}

window.addEventListener("hashchange", () => { lastRender = ""; window.scrollTo(0, 0); refresh(); });
refresh();
setInterval(refresh, 1500);
