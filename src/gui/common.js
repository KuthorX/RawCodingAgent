"use strict";
// Shared by all pages: token handling, API calls, DOM helpers, source-file links.
const TOKEN = new URLSearchParams(location.search).get("token");
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
  const query = new URLSearchParams({ token: TOKEN, ...params });
  return `${path}?${query}`;
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-agent-token": TOKEN, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${data.error || res.statusText}`);
  return data;
}

function rawUrl(session, file, line) {
  return withToken("/raw", { session, file, ...(line ? { line: String(line) } : {}) }) + (line ? `#L${line}` : "");
}

function revealButton(session, file) {
  const btn = el("button", "small", "在 Finder 中显示");
  btn.type = "button";
  btn.title = `用系统文件管理器打开 ${file} 所在目录`;
  btn.onclick = () => api(`/api/sessions/${session}/reveal`, { name: file }).catch((e) => alert(e.message));
  return btn;
}

// "trace.jsonl 查看 · 在 Finder 中显示" for every session file.
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

function requireToken(target) {
  if (TOKEN) return true;
  target.replaceChildren(el("div", "banner", "缺少 token：请使用终端里打印的完整地址打开。"));
  return false;
}
