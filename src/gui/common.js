"use strict";
// Shared by all pages: token handling, API calls, DOM helpers, source-file links.
const TOKEN = new URLSearchParams(location.search).get("token");
// Opened from another device through `tailscale serve` (--remote): no token, a device cookie set by pairing instead.
const REMOTE = location.hostname !== "127.0.0.1" && location.hostname !== "localhost";
// A touch screen without a mouse (phones, tablets): no hover, no keyboard shortcuts.
const TOUCH = matchMedia("(hover: none)").matches;
const FILES = ["trace.jsonl", "events.jsonl", "messages.json", "meta.json"];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function link(href, text, newTab) {
  const a = el("a", "", text);
  a.href = href;
  if (newTab) a.target = "_blank";
  return a;
}

function withToken(path, params = {}) {
  const query = new URLSearchParams({ ...(TOKEN ? { token: TOKEN } : {}), ...params });
  return query.size ? `${path}?${query}` : path;
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(TOKEN ? { "x-agent-token": TOKEN } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  // Never paired, or revoked on the host.
  if (REMOTE && res.status === 401) top.location.href = "/pair";
  if (!res.ok) throw new Error(`${res.status} ${data.error || res.statusText}`);
  return data;
}

// In-page replacements for alert() / confirm(), in the same look as the rest. Enter confirms, Esc cancels;
// a dangerous confirmation starts on "取消", so Enter alone never deletes anything.
function uiDialog(message, { title, ok, cancel, danger }) {
  return new Promise((resolve) => {
    const box = el("dialog", "ui" + (danger ? " danger" : ""));
    const row = el("div", "row");
    const button = (label, value, className) => {
      const b = el("button", className, label);
      b.type = "button";
      b.onclick = () => box.close(value);
      row.append(b);
      return b;
    };
    const no = cancel ? button(cancel, "cancel", "") : null;
    const yes = button(ok, "ok", danger ? "danger" : "primary");
    box.append(el("h3", "", title), el("p", "", message), row);
    box.addEventListener("close", () => {
      box.remove();
      resolve(box.returnValue === "ok");
    });
    document.body.append(box);
    box.showModal();
    (danger && no ? no : yes).focus();
  });
}

// confirm(): resolves true when confirmed.
function ask(message, { title = "确认", ok = "确定", danger = false } = {}) {
  return uiDialog(message, { title, ok, cancel: "取消", danger });
}

// alert() for a failed request; the HTTP status in front of the message ("409 …") is left out.
function notice(err, title = "出错了") {
  return uiDialog(String(err?.message ?? err).replace(/^\d{3} /, ""), { title, ok: "知道了" });
}

function rawUrl(session, file, line) {
  return withToken("/raw", { session, file, ...(line ? { line: String(line) } : {}) }) + (line ? `#L${line}` : "");
}

// What the OS calls its file manager.
const FILE_MANAGER = /Mac/.test(navigator.platform) ? "Finder" : /Win/.test(navigator.platform) ? "资源管理器" : "文件管理器";

// Nothing from another device: the file manager would open on the host's screen.
function revealButton(session, file, label = "定位") {
  if (REMOTE) return document.createDocumentFragment();
  const btn = el("button", "small", label);
  btn.type = "button";
  btn.title = `在${FILE_MANAGER}中显示 ${file}`;
  btn.onclick = () => api(`/api/sessions/${session}/reveal`, { name: file }).catch(notice);
  return btn;
}

// "trace.jsonl 查看内容 定位" for every session file.
function fileLinks(session, files = FILES) {
  const box = el("div", "files");
  for (const file of files) {
    const item = el("span", "file");
    item.append(el("code", "", file), link(rawUrl(session, file), "查看内容", true), revealButton(session, file));
    box.append(item);
  }
  return box;
}

// D10: conversations above this many input tokens are flagged; compaction isn't implemented yet.
const CONTEXT_WARN_TOKENS = 300_000;

const fmt = {
  int: (n) => (n ?? 0).toLocaleString("en-US"),
  k: (n) => ((n ?? 0) >= 1000 ? `${Math.round(n / 1000)}k` : String(n ?? 0)),
  usd: (n) => `$${(n ?? 0).toFixed(4)}`,
  ms: (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`),
  time: (iso) => (iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : ""),
};

// Links to token-only pages, e.g. <a data-page="/iterations">.
for (const a of document.querySelectorAll("a[data-page]")) a.href = withToken(a.dataset.page);

// Stats and the iteration log are tabs of the main page (/), shown there in an iframe that is kept alive,
// so switching tabs never reloads them. Opened on their own they move into the main page; inside it they hide
// their own top bar and mirror their address (#<id>) into the main page's (#<tab>/<id>).
const EMBEDDED = window.top !== window;
function asTab(tab) {
  const target = () => "#" + tab + (location.hash.length > 1 ? "/" + location.hash.slice(1) : "");
  if (!EMBEDDED) {
    if (!TOKEN && !REMOTE) return () => {}; // requireToken() explains
    location.replace(withToken("/") + target());
    return false;
  }
  document.documentElement.classList.add("embedded");
  // Only while this tab is the one showing: a preloaded frame must not take over the address.
  const sync = () => { if (top.location.hash.slice(1).split("/")[0] === tab) top.history.replaceState(null, "", target()); };
  addEventListener("hashchange", sync);
  addEventListener("keydown", (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.target.closest?.("input, textarea, select")) return;
    if ("1234".includes(ev.key) && ev.key.length === 1) top.switchTab?.(ev.key);
  });
  return sync;
}

// A link into the chat tab of the main page.
function openChat(id) {
  if (EMBEDDED) top.location.hash = id;
  else location.href = withToken("/") + "#" + id;
}

function requireToken(target) {
  if (TOKEN || REMOTE) return true;
  target.replaceChildren(el("div", "banner", "缺少 token：请使用终端里打印的完整地址打开。"));
  return false;
}
