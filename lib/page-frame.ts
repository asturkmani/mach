// The document a page runs as: its HTML with Mach's look (colours, type and a
// few building blocks) and its data put in front of it. It's served from its
// own route under a Content-Security-Policy that sandboxes it (an opaque
// origin, so no cookies or storage of Mach's) and blocks every connection:
// whatever a page's script does, it can only draw what it was handed.

export type FrameTheme = "light" | "dark" | "system";

export type FrameFile = { path: string; updatedAt: string | null; value?: unknown; problem?: string };

/** Scripts may come from jsDelivr (pinned chart libraries); nothing may connect anywhere. */
export const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  "sandbox allow-scripts",
].join("; ");

const TOKENS_LIGHT = `--bg:#f2f0ec;--panel:#fbfaf8;--raised:#fff;--hover:#efece7;--selected:#e8e4de;--line:#d9d4cc;--line-soft:#e8e4de;--ink:#1c1b19;--muted:#5f5a53;--faint:#8a857d;--accent:#c24a17;--accent-soft:rgba(212,82,28,.1);--ok:#2f7347;--warn:#8f5e12;--danger:#b13623;--up:#2f7347;--down:#b13623;--series-1:#2a78d6;--series-2:#eb6834;--series-3:#1baf7a;--series-4:#eda100;--series-5:#e87ba4;--series-6:#008300;--series-7:#4a3aa7;--series-8:#e34948;color-scheme:light`;
const TOKENS_DARK = `--bg:#171615;--panel:#1e1d1b;--raised:#252422;--hover:#282624;--selected:#302e2b;--line:#393633;--line-soft:#2c2a27;--ink:#ece8e2;--muted:#a39e97;--faint:#8a857e;--accent:#ef6b33;--accent-soft:rgba(239,107,51,.13);--ok:#6fbf89;--warn:#e0a64a;--danger:#f07a64;--up:#6fbf89;--down:#f07a64;--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70;--series-4:#c98500;--series-5:#d55181;--series-6:#008300;--series-7:#9085e9;--series-8:#e66767;color-scheme:dark`;

/** Mach's look for pages: tokens, type, and a few classes the building-pages skill documents. */
export const PAGE_KIT_CSS = `
:root{${TOKENS_LIGHT}}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${TOKENS_DARK}}}
:root[data-theme="dark"]{${TOKENS_DARK}}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0}
body{background:var(--panel);color:var(--ink);font:15px/1.5 Geist,ui-sans-serif,system-ui,sans-serif;padding:24px 32px 40px}
@media (max-width:640px){body{padding:16px}}
h1,h2,h3{font-weight:500;letter-spacing:-.01em;margin:0 0 .5em}
h1{font-size:22px}h2{font-size:17px}h3{font-size:15px}
p{margin:0 0 .75em}
a{color:var(--accent)}
.label{font-family:"Geist Mono",ui-monospace,monospace;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
.mono,.num{font-family:"Geist Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}.faint{color:var(--faint)}
.up{color:var(--up)}.down{color:var(--down)}
.stack{display:flex;flex-direction:column;gap:16px}
.row{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
.card{border:1px solid var(--line);background:var(--raised);padding:16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));border:1px solid var(--line);background:var(--raised)}
.stat{display:flex;flex-direction:column;gap:4px;padding:14px 16px;border-right:1px solid var(--line-soft)}
.stat:last-child{border-right:0}
.stat .value{font-family:"Geist Mono",ui-monospace,monospace;font-size:22px;font-variant-numeric:tabular-nums}
.stat .note{font-size:12px;color:var(--muted)}
.table-wrap{overflow-x:auto;border:1px solid var(--line);background:var(--raised)}
table{border-collapse:collapse;width:100%;font-size:13px}
th{font-family:"Geist Mono",ui-monospace,monospace;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:400;text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:8px 12px;border-bottom:1px solid var(--line-soft);vertical-align:top}
tr:last-child td{border-bottom:0}
tbody tr:hover td{background:var(--hover)}
th.num,td.num{text-align:right;white-space:nowrap}
.bar{height:10px;background:var(--series-1);border-radius:0 3px 3px 0}
.empty{padding:32px;text-align:center;color:var(--muted);border:1px dashed var(--line)}
`;

/** Helpers every page gets on window.mach, besides its data. */
const HELPERS = `
(function(){
  var m = window.mach;
  m.file = function(path){ return m.files.find(function(f){ return f.path === path; }) || null; };
  m.csv = function(path){
    var text = typeof path === "string" && m.data[path] !== undefined ? m.data[path] : path;
    if (typeof text !== "string") return [];
    var rows = [], row = [], cell = "", quoted = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\\n" || c === "\\r") {
        if (c === "\\r" && text[i + 1] === "\\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += c;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    var head = rows.shift() || [];
    return rows.filter(function(r){ return r.length > 1 || r[0] !== ""; }).map(function(r){
      var o = {}; head.forEach(function(h, j){ o[h] = r[j] === undefined ? "" : r[j]; }); return o;
    });
  };
  m.number = function(value, options){
    var n = Number(value);
    return isFinite(n) ? n.toLocaleString(undefined, options || { maximumFractionDigits: 2 }) : "–";
  };
  m.money = function(value, currency, options){
    var n = Number(value);
    if (!isFinite(n)) return "–";
    var o = Object.assign({ style: "currency", currency: currency || "USD", maximumFractionDigits: 0 }, options || {});
    if (Math.abs(n) >= 1e6 && !(options && options.full)) { o.notation = "compact"; o.maximumFractionDigits = 1; }
    return n.toLocaleString(undefined, o);
  };
  m.percent = function(value, digits){
    var n = Number(value);
    return isFinite(n) ? (n * 100).toFixed(digits === undefined ? 1 : digits) + "%" : "–";
  };
  m.ago = function(when){
    if (!when) return "never";
    var s = (Date.now() - new Date(when).getTime()) / 1000;
    if (s < 90) return "just now";
    if (s < 5400) return Math.round(s / 60) + " min ago";
    if (s < 129600) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " days ago";
  };
})();
`;

/** JSON that is safe inside a <script> element. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * The page's HTML with Mach's head put in front of its own: the kit's styles
 * come first so the page can override them, and window.mach is set before
 * any of its scripts run.
 */
export function buildPageDocument(input: { html: string; title: string; theme: FrameTheme; files: FrameFile[]; now?: Date }): string {
  const data: Record<string, unknown> = {};
  for (const file of input.files) if (file.value !== undefined) data[file.path] = file.value;
  const mach = {
    title: input.title,
    theme: input.theme,
    data,
    files: input.files.map(({ path, updatedAt, problem }) => ({ path, updatedAt, problem: problem ?? null })),
    generatedAt: (input.now ?? new Date()).toISOString(),
  };
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap">',
    `<style data-mach-kit>${PAGE_KIT_CSS}</style>`,
    `<script>window.mach = ${scriptJson(mach)};${HELPERS}</script>`,
  ].join("\n");
  const themeAttr = input.theme === "system" ? "" : ` data-theme="${input.theme}"`;

  let html = input.html.replace(/^﻿/, "");
  // Mach sets the theme; a page's own data-theme would fight it.
  html = html.replace(/<html\b([^>]*)>/i, (_, attrs: string) => `<html${attrs.replace(/\sdata-theme=("[^"]*"|'[^']*'|\S+)/i, "")}${themeAttr}>`);
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (tag) => `${tag}\n${head}\n`);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (tag) => `${tag}\n<head>\n${head}\n</head>\n`);
  return `<!doctype html>\n<html lang="en"${themeAttr}>\n<head>\n${head}\n</head>\n<body>\n${html}\n</body>\n</html>\n`;
}
