"use strict";
// A small Markdown renderer for assistant messages: the subset models actually write (headings, emphasis,
// inline code, fenced code, lists, quotes, tables, links, rules). Parsing produces plain data (tested in Node);
// rendering builds DOM nodes with textContent only, never innerHTML, so model output can't inject markup.

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function startsBlock(line, next) {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line) || isTableStart(line, next);
}

function isTableStart(line, next) {
  return line.includes("|") && next !== undefined && TABLE_DIVIDER.test(next) && next.includes("-");
}

// Splits a table row on pipes that are neither escaped nor inside inline code.
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cell = "";
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (c === "`") {
      inCode = !inCode;
      cell += c;
    } else if (c === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += c;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function parseMarkdown(text) {
  return parseBlocks(text.replace(/\r\n?/g, "\n").split("\n"));
}

function parseBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body = [];
      i++;
      // An unclosed fence runs to the end, like a code block still being written.
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ type: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, inline: parseInline(heading[2]) });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(QUOTE.exec(lines[i++])[1]);
      blocks.push({ type: "quote", blocks: parseBlocks(inner) });
      continue;
    }

    if (isTableStart(line, lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : c.startsWith(":") ? "left" : ""));
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]));
      blocks.push({
        type: "table",
        align: head.map((_, c) => align[c] || ""),
        head: head.map(parseInline),
        rows: rows.map((r) => head.map((_, c) => parseInline(r[c] || ""))),
      });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]);
      const list = { type: "list", ordered, start: ordered ? parseInt(item[2], 10) : 1, items: [] };
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (!m || m[1].length > item[1].length || /\d/.test(m[2]) !== ordered) break;
        // The item's content: its first line, then every following line indented past the marker
        // (blank lines included, if more indented content follows).
        const indent = m[1].length + m[2].length + 1;
        const body = [m[3]];
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (l.trim() === "") {
            let j = i;
            while (j < lines.length && lines[j].trim() === "") j++;
            if (j < lines.length && lines[j].length - lines[j].trimStart().length >= indent) {
              body.push(...lines.slice(i, j));
              i = j;
              continue;
            }
            break;
          }
          const lead = l.length - l.trimStart().length;
          if (lead >= indent || (lead > m[1].length && LIST_ITEM.test(l))) body.push(l.slice(Math.min(lead, indent)));
          else if (!startsBlock(l, lines[i + 1]) && lead > 0) body.push(l.trimStart()); // lazy continuation
          else break;
          i++;
        }
        list.items.push(parseBlocks(body));
        while (i < lines.length && lines[i].trim() === "" && LIST_ITEM.test(lines[i + 1] || "")) i++;
      }
      blocks.push(list);
      continue;
    }

    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) para.push(lines[i++]);
    blocks.push({ type: "para", inline: parseInline(para.map((l) => l.trim()).join("\n")) });
  }
  return blocks;
}

// Inline syntax, tried at each position in this order. Each returns [token, length] or null.
const INLINE_RULES = [
  (s) => {
    const m = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(s);
    return m && [{ type: "code", text: m[2].replace(/^ (.*) $/, "$1") }, m[0].length];
  },
  (s) => {
    const m = /^\\([!-/:-@[-`{-~])/.exec(s);
    return m && [{ type: "text", text: m[1] }, 2];
  },
  (s) => {
    // The URL may contain one level of balanced parentheses, e.g. https://en.wikipedia.org/wiki/Foo_(bar)
    const m = /^\[([^\]]+)\]\(\s*((?:[^\s()]|\([^\s()]*\))+)\s*\)/.exec(s);
    return m && [{ type: "link", href: m[2], children: parseInline(m[1]) }, m[0].length];
  },
  (s) => {
    // ASCII only, so Chinese text right after a URL isn't swallowed; trailing punctuation belongs to the sentence.
    const m = /^https?:\/\/[\w\-.~:/?#[\]@!$&'*+,;=%]+/.exec(s);
    const url = m && m[0].replace(/[.,;:!?'*]+$/, "");
    return url && url.length > 8 && [{ type: "link", href: url, children: [{ type: "text", text: url }] }, url.length];
  },
  (s) => delimited(s, "**", "strong") || delimited(s, "__", "strong") || delimited(s, "~~", "del"),
  (s) => delimited(s, "*", "em") || delimited(s, "_", "em"),
];

// `**x**`-style spans: the content must not start or end with a space; `_` only counts at word boundaries,
// so snake_case names stay intact.
function delimited(s, marker, type) {
  const n = marker.length;
  const single = n === 1;
  if (!s.startsWith(marker) || !s[n] || /\s/.test(s[n]) || (single && s[n] === marker)) return null;
  for (let end = s.indexOf(marker, n + 1); end !== -1; end = s.indexOf(marker, end + 1)) {
    if (/\s/.test(s[end - 1])) continue;
    if (single && (s[end - 1] === marker || s[end + 1] === marker)) continue; // part of a `**`
    if (marker[0] === "_" && s[end + n] && /\w/.test(s[end + n])) continue;
    return [{ type, children: parseInline(s.slice(n, end)) }, end + n];
  }
  return null;
}

function parseInline(s) {
  const out = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ type: "text", text });
    text = "";
  };
  for (let i = 0; i < s.length; ) {
    const rest = s.slice(i);
    const prev = s[i - 1];
    let hit = null;
    // `_` emphasis can't start inside a word (snake_case).
    if (!(rest[0] === "_" && prev && /\w/.test(prev))) {
      for (const rule of INLINE_RULES) if ((hit = rule(rest))) break;
    }
    if (hit) {
      const [token, len] = hit;
      if (token.type === "text") {
        text += token.text;
      } else {
        flush();
        out.push(token);
      }
      i += len;
    } else {
      text += s[i++];
    }
  }
  flush();
  return out;
}

// ---------- DOM ----------
function renderInline(tokens, parent) {
  for (const t of tokens) {
    if (t.type === "text") {
      t.text.split("\n").forEach((part, i) => {
        if (i > 0) parent.append(document.createElement("br"));
        if (part) parent.append(document.createTextNode(part));
      });
    } else if (t.type === "code") {
      const code = document.createElement("code");
      code.textContent = t.text;
      parent.append(code);
    } else if (t.type === "link") {
      // Only web links become clickable; anything else (javascript:, file paths) stays text.
      if (/^https?:\/\//i.test(t.href)) {
        const a = document.createElement("a");
        a.href = t.href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        renderInline(t.children, a);
        parent.append(a);
      } else {
        renderInline(t.children, parent);
      }
    } else {
      const node = document.createElement(t.type);
      renderInline(t.children, node);
      parent.append(node);
    }
  }
}

function renderBlocks(blocks, parent) {
  for (const b of blocks) {
    let node;
    switch (b.type) {
      case "code": {
        node = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = b.text;
        if (b.lang) node.dataset.lang = b.lang;
        node.append(code);
        break;
      }
      case "heading":
        node = document.createElement(`h${b.level}`);
        renderInline(b.inline, node);
        break;
      case "rule":
        node = document.createElement("hr");
        break;
      case "quote":
        node = document.createElement("blockquote");
        renderBlocks(b.blocks, node);
        break;
      case "list":
        node = document.createElement(b.ordered ? "ol" : "ul");
        if (b.ordered && b.start !== 1) node.start = b.start;
        for (const item of b.items) {
          const li = document.createElement("li");
          // A one-paragraph item renders without the <p>, so tight lists stay tight.
          if (item.length === 1 && item[0].type === "para") renderInline(item[0].inline, li);
          else renderBlocks(item, li);
          node.append(li);
        }
        break;
      case "table": {
        node = document.createElement("div");
        node.className = "table-wrap";
        const table = document.createElement("table");
        const row = (cells, tag) => {
          const tr = document.createElement("tr");
          cells.forEach((cell, c) => {
            const td = document.createElement(tag);
            if (b.align[c]) td.style.textAlign = b.align[c];
            renderInline(cell, td);
            tr.append(td);
          });
          return tr;
        };
        const thead = document.createElement("thead");
        thead.append(row(b.head, "th"));
        const tbody = document.createElement("tbody");
        for (const r of b.rows) tbody.append(row(r, "td"));
        table.append(thead, tbody);
        node.append(table);
        break;
      }
      default:
        node = document.createElement("p");
        renderInline(b.inline, node);
    }
    parent.append(node);
  }
}

function renderMarkdown(text) {
  const fragment = document.createDocumentFragment();
  renderBlocks(parseMarkdown(text), fragment);
  return fragment;
}
