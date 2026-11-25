#!/usr/bin/env node
/**
 * Renders the README's architecture diagram.
 *
 *   cd docs/diagram && npm install && npx playwright install chromium && npm run render
 *
 * Writes docs/architecture-dark.png and docs/architecture-light.png.
 *
 * Every word is set in HTML with Inter (fonts/) and rendered by Playwright at 2x on a transparent
 * background, so each variant sits on GitHub's own light or dark page. Before anything is written, the
 * layout is checked in the page: nothing overlaps, nothing is clipped, no connector runs through a box,
 * every text meets 4.5:1 contrast against what is behind it. Any finding stops the run.
 *
 * The style follows the ADEXTO README diagrams (github.com/0xcuy/adexto, docs/assets/readme/render.mjs).
 * Facts drawn here must match the README and the code: this file only draws.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── Lucide icons, read from the installed lucide-react (ISC) ────────────────────────────────────────
const lucideDir = path.join(path.dirname(require.resolve("lucide-react/package.json")), "dist/esm/icons");
function iconNodes(name) {
  const src = readFileSync(path.join(lucideDir, `${name}.js`), "utf8");
  if (!src.includes("createLucideIcon(")) throw new Error(`lucide icon "${name}" is an alias`);
  const start = src.indexOf("[", src.indexOf("createLucideIcon("));
  const end = src.lastIndexOf("]);");
  return Function(`"use strict"; return (${src.slice(start, end + 1)});`)();
}
function icon(name, color, size = 20, width = 2) {
  const body = iconNodes(name)
    .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).filter(([k]) => k !== "key").map(([k, v]) => `${k}="${esc(v)}"`).join(" ")}/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

const FONTS = `@font-face{font-family:"InterV";src:url(data:font/woff2;base64,${readFileSync(path.join(HERE, "fonts/Inter-Variable.woff2")).toString("base64")}) format("woff2");font-weight:100 900;}`;

// ── Themes: the page behind each variant is GitHub's own canvas ─────────────────────────────────────
const THEMES = {
  light: {
    page: "#ffffff", ink: "#1f2328", muted: "#59636e",
    panel: "#f6f8fa", panelBorder: "#d1d9e0", card: "#ffffff", cardBorder: "#d1d9e0",
    ours: "#6d28d9", oursSoft: "#f3efff", oursBorder: "#c4b5fd",
    ok: "#047857", okSoft: "#e8f8f1", okBorder: "#99e2c5",
    plan: "#9a6700", planSoft: "#fff8c5", planBorder: "#d4a72c",
    third: "#59636e", thirdBorder: "#9aa4ae",
    arrow: "#7c3aed", code: "#eff1f4",
    shadow: "0 1px 2px rgba(31,35,40,.06), 0 8px 22px rgba(31,35,40,.07)",
  },
  dark: {
    page: "#0d1117", ink: "#e6edf3", muted: "#9da7b3",
    panel: "#151b23", panelBorder: "#2f3742", card: "#0d1117", cardBorder: "#3d444d",
    ours: "#b39dff", oursSoft: "rgba(124,58,237,.20)", oursBorder: "rgba(167,139,250,.50)",
    ok: "#4ade9f", okSoft: "rgba(16,185,129,.16)", okBorder: "rgba(52,211,153,.42)",
    plan: "#e3b341", planSoft: "rgba(187,128,9,.16)", planBorder: "rgba(227,179,65,.55)",
    third: "#9da7b3", thirdBorder: "#59636e",
    arrow: "#a78bfa", code: "#1f2630",
    shadow: "0 1px 2px rgba(0,0,0,.45), 0 10px 26px rgba(0,0,0,.40)",
  },
};

const css = (t, W, H) => `${FONTS}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${W}px;height:${H}px;background:transparent;overflow:hidden}
body{position:relative;font-family:InterV,sans-serif;color:${t.ink};-webkit-font-smoothing:antialiased;font-feature-settings:"cv11","ss01"}
.panel{position:absolute;border-radius:18px;background:${t.panel};border:1px solid ${t.panelBorder}}
.ptitle{position:absolute;font:700 11.5px/1 InterV;letter-spacing:.13em;text-transform:uppercase;color:${t.muted};white-space:nowrap}
.card{position:absolute;border-radius:14px;background:${t.card};border:1px solid ${t.cardBorder};box-shadow:${t.shadow};padding:16px 18px;overflow:hidden}
.card.ours{border-color:${t.oursBorder}}
.card.third{border-style:dashed;border-color:${t.thirdBorder};box-shadow:none;background:transparent}
.card.plan{border-style:dashed;border-color:${t.planBorder};box-shadow:none;background:transparent}
.head{display:flex;align-items:center;gap:11px;min-width:0}
.ic{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;background:${t.oursSoft};flex:none}
.ic.third{background:transparent;border:1px dashed ${t.thirdBorder}}
.ic.plan{background:${t.planSoft}}
.tt{display:flex;flex-direction:column;gap:3px;min-width:0}
.trow{display:flex;align-items:center;gap:8px}
.title{font:650 16px/1.15 InterV;white-space:nowrap;letter-spacing:-.005em}
.sub{font:400 13px/1.25 InterV;color:${t.muted};white-space:nowrap}
.mono{font:500 12px/1.25 "DejaVu Sans Mono",ui-monospace,monospace}
.tag{font:700 10px/1 InterV;letter-spacing:.08em;text-transform:uppercase;color:${t.plan};background:${t.planSoft};border:1px dashed ${t.planBorder};padding:4px 7px;border-radius:999px;white-space:nowrap}
ul.b{list-style:none;margin-top:13px;display:grid;gap:7px}
ul.b li{position:relative;padding-left:16px;font:400 13.5px/1.3 InterV;color:${t.muted};white-space:nowrap}
ul.b li::before{content:"";position:absolute;left:2px;top:7px;width:6px;height:6px;border-radius:50%;background:${t.ours}}
.third ul.b li::before{background:${t.third}}
.plan ul.b li::before{background:${t.plan}}
.chip{display:inline-flex;align-items:center;gap:8px;height:30px;padding:0 12px 0 9px;border-radius:999px;border:1px dashed ${t.thirdBorder};font:500 12.5px/1 InterV;color:${t.muted};white-space:nowrap}
.chip svg{display:block}
.solid{border-style:solid;border-color:${t.okBorder};background:${t.card};color:${t.ink}}
.label{position:absolute;font:500 12.5px/1.2 InterV;color:${t.muted};white-space:nowrap}
.wires{position:absolute;left:0;top:0;pointer-events:none}
`;

const marker = (t) => `<defs><marker id="ah" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${t.arrow}"/></marker></defs>`;

// ── Content: the architecture as it runs today, plus the planned hardening ─────────────────────────
const USERS = [
  ["message-circle", "Telegram user", "in their own chat with the bot"],
  ["glasses", "G2 glasses wearer", "ring + tap, voice, save to Telegram"],
];
const SERVICES = [
  ["app-window", "G2 app", "g2-app/src/main.ts · on the glasses", ["One story at a time, 576 × 288", "Next, Save to Telegram, Voice", "Reloads the digest every 5 min"], "glasses", "Even Hub SDK · glasses bridge"],
  ["route", "Traefik", "on the SIERA VPS", ["TLS for headsup.sieralabs.com", "Routes to the droplet over Tailscale", "Forwards to port :8787"], "network", "Tailscale · VPS to droplet"],
  ["server", "Telegram bot backend", "backend/server.mjs", ["Node ≥ 22, zero npm dependencies", "On the 32GB droplet, port :8787", "State in state.json"], "send", "Telegram Bot API · @HeadsUpNewsBot"],
  ["audio-lines", "Voice poller", "voice-poller/deepgram_poller.py", ["Runs on the 32GB droplet", "Deepgram key in a mode-600 file", "Posts transcripts back"], "audio-waveform", "Deepgram · nova-2"],
];
const THIRD = [
  ["send", "Telegram Bot API", "api.telegram.org", ["getUpdates long polling, 25 s", "sendMessage, plain text only", "Digests, saves, breaking alerts"]],
  ["rss", "RSS feeds", "public feeds, every 30 min", ["BBC World, The Guardian World", "Al Jazeera, The Verge", "Title and description only"]],
  ["sparkles", "0G Compute router", "router-api.0g.ai · glm-5.3-flash", ["Picks and rewrites 8 stories", "Headlines ≤ 10 words, summaries ≤ 18", "10 languages via /lang"]],
  ["audio-waveform", "Deepgram", "api.deepgram.com · nova-2", ["Speech to text for ~4 s clips", "next, save this, repeat", "Called only by the voice poller"]],
];
const PLANNED = [
  ["link", "Pair the glasses", "g2-app + backend", ["Keep a UUID v4 device id", "Show the /api/pair/start code", "Send ?device= on digest and save"]],
  ["key-round", "Voice relay secret", "backend + voice poller", ["Secret header from the poller", "On /api/voice-jobs and the audio", "And on /api/voice-result"]],
  ["database-backup", "Atomic state writes", "backend/server.mjs", ["Write a temp file, then rename", "Keep state.json.bak", "Today: written in place"]],
  ["shield-check", "Guard open endpoints", "backend/server.mjs", ["/api/save needs a paired device", "/api/refresh is rate-limited", "Today: both open to anyone"]],
];
const PLATFORMS = [
  ["glasses", "Even Realities G2"], ["app-window", "Even Hub"], ["send", "Telegram"], ["server", "Node.js ≥ 22"],
  ["cloud", "Cloudflare"], ["route", "SIERA VPS"], ["cpu", "32GB droplet"],
];

function architecture(t) {
  const W = 1878, H = 1128;
  // The first gap is wider: it holds the Cloudflare hop between the G2 app and Traefik.
  const M = 48, LW = 320, G = 96, GCF = 310, CFW = 170, GAPS = [GCF, G, G];
  const L = [M]; for (const gp of GAPS) L.push(L.at(-1) + LW + gp);
  const cx = L.map((x) => x + LW / 2);
  const Y = { user: 32, uh: 72, p1: 178, s: 214, sh: 190, p2: 568, o: 604, oh: 148, p3: 806, pl: 842, plh: 148 };
  const sBot = Y.s + Y.sh, oMid = Y.o + Y.oh / 2;

  const users = USERS.map(([ic, ti, su], i) => `
    <div class="card" data-box data-id="u${i}" style="left:${L[i]}px;top:${Y.user}px;width:${LW}px;height:${Y.uh}px">
      <div class="head"><div class="ic">${icon(ic, t.ours, 20)}</div><div class="tt"><div class="title">${esc(ti)}</div><div class="sub">${esc(su)}</div></div></div>
    </div>`).join("");
  const card = (cls, id, x, y, h, ic, ti, su, bl, extra = "", tag = "") => `
    <div class="card ${cls}" data-box data-id="${id}" style="left:${x}px;top:${y}px;width:${LW}px;height:${h}px">
      <div class="head"><div class="ic ${cls}">${icon(ic, cls === "third" ? t.third : cls === "plan" ? t.plan : t.ours, 20)}</div><div class="tt"><div class="title">${esc(ti)}</div><div class="trow"><div class="sub${su.includes("/") && !su.includes(" ") ? " mono" : ""}">${esc(su)}</div>${tag}</div></div></div>
      <ul class="b">${bl.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>${extra}
    </div>`;
  const services = SERVICES.map(([ic, ti, su, bl, chipIc, chip], i) =>
    card("ours", `s${i}`, L[i], Y.s, Y.sh, ic, ti, su, bl, `<div style="margin-top:13px"><span class="chip">${icon(chipIc, t.muted, 16)}${esc(chip)}</span></div>`)).join("");
  const cfX = L[0] + LW + 105, cfH = 72;
  const cf = `
    <div class="card third" data-box data-id="cf" style="left:${cfX}px;top:${Y.s + 74 - cfH / 2}px;width:${CFW}px;height:${cfH}px;padding:16px 12px">
      <div class="head"><div class="ic third">${icon("cloud", t.third, 20)}</div><div class="tt"><div class="title">Cloudflare</div><div class="sub">proxied DNS</div></div></div>
    </div>`;
  const third = THIRD.map(([ic, ti, su, bl], i) => card("third", `o${i}`, L[i], Y.o, Y.oh, ic, ti, su, bl)).join("");
  const planned = PLANNED.map(([ic, ti, su, bl], i) => card("plan", `p${i}`, L[i], Y.pl, Y.plh, ic, ti, su, bl, "", `<span class="tag">Planned</span>`)).join("");

  const chipsTop = Y.p3 + Y.plh + 36 + 30 + 24;
  const chips = `<div data-box data-id="chips" style="position:absolute;left:32px;top:${chipsTop}px;width:${W - 64}px;display:flex;justify-content:center;gap:12px">
      ${PLATFORMS.map(([ic, n]) => `<span class="chip solid">${icon(ic, t.ok, 16)}${esc(n)}</span>`).join("")}
    </div>`;
  const legend = `<div data-box data-id="legend" style="position:absolute;left:0;top:${chipsTop + 58}px;width:${W}px;display:flex;justify-content:center;gap:26px;font:500 12.5px/1 InterV;color:${t.muted}">
      <span style="display:flex;align-items:center;gap:8px"><svg width="30" height="10"><line x1="1" y1="5" x2="22" y2="5" stroke="${t.arrow}" stroke-width="2"/><path d="M21 1 L29 5 L21 9 z" fill="${t.arrow}"/></svg>request, toward the side that answers</span>
      <span style="display:flex;align-items:center;gap:8px"><i style="width:14px;height:14px;border-radius:4px;border:1.5px solid ${t.oursBorder};background:${t.oursSoft}"></i>run by SIERA</span>
      <span style="display:flex;align-items:center;gap:8px"><i style="width:14px;height:14px;border-radius:4px;border:1.5px dashed ${t.thirdBorder}"></i>third party</span>
      <span style="display:flex;align-items:center;gap:8px"><i style="width:14px;height:14px;border-radius:4px;border:1.5px dashed ${t.planBorder};background:${t.planSoft}"></i>planned, not built yet</span>
      <span style="display:flex;align-items:center;gap:8px"><i style="width:14px;height:14px;border-radius:999px;border:1.5px solid ${t.okBorder}"></i>platform</span>
    </div>`;

  // Lanes between the service and third-party panels: the Telegram lane runs above the RSS lane, and
  // the RSS wire leaves the backend to the right of the Telegram wire, so the two never cross.
  const tgX = L[2] + 44, rssX = L[2] + 118, ogX = L[2] + LW - 70, laneTg = sBot + 52, laneRss = sBot + 102, tgEnd = L[0] + LW - 80;
  const wearX = L[1] + 76, appX = L[0] + LW - 76, jogY = Y.user + Y.uh + 46;
  const midY = Y.s + 74;
  const gapX = (i) => L[i] + LW;
  const wires = [
    { d: `M${L[0]} ${Y.user + Y.uh / 2} L18 ${Y.user + Y.uh / 2} L18 ${oMid} L${L[0] - 2} ${oMid}`, from: "u0", to: "o0" },
    { d: `M${wearX} ${Y.user + Y.uh} L${wearX} ${jogY} L${appX} ${jogY} L${appX} ${Y.s - 3}`, from: "u1", to: "s0" },
    { d: `M${gapX(0)} ${midY} L${cfX - 2} ${midY}`, from: "s0", to: "cf" },
    { d: `M${cfX + CFW} ${midY} L${L[1] - 2} ${midY}`, from: "cf", to: "s1" },
    { d: `M${gapX(1)} ${midY} L${L[2] - 2} ${midY}`, from: "s1", to: "s2" },
    { d: `M${L[3]} ${midY} L${gapX(2) + 2} ${midY}`, from: "s3", to: "s2" },
    { d: `M${tgX} ${sBot} L${tgX} ${laneTg} L${tgEnd} ${laneTg} L${tgEnd} ${Y.o - 3}`, from: "s2", to: "o0" },
    { d: `M${rssX} ${sBot} L${rssX} ${laneRss} L${cx[1]} ${laneRss} L${cx[1]} ${Y.o - 3}`, from: "s2", to: "o1" },
    { d: `M${ogX} ${sBot} L${ogX} ${Y.o - 3}`, from: "s2", to: "o2" },
    { d: `M${cx[3]} ${sBot} L${cx[3]} ${Y.o - 3}`, from: "s3", to: "o3" },
  ];
  const lab = (id, x, y, lines, center = false) => `<div class="label" data-box data-id="${id}" style="left:${x}px;top:${y}px;${center ? "transform:translateX(-50%);text-align:center;" : ""}">${lines.map(esc).join("<br>")}</div>`;
  const g = (i) => (i === 0 ? gapX(0) + 105 / 2 : gapX(i) + G / 2);
  const labels = [
    lab("lu0", 30, Y.user + Y.uh + 12, ["Telegram app:", "/digest, /saved, /pair CODE"]),
    lab("lu1", wearX + 12, Y.user + Y.uh + 12, ["ring, tap, voice"]),
    lab("ls0a", g(0), midY - 26, ["HTTPS"], true),
    lab("ls0b", g(0), midY + 10, ["/api/digest", "/api/save", "/api/voice"], true),
    lab("ls1a", g(1), midY - 26, ["Tailscale"], true),
    lab("ls1b", g(1), midY + 10, [":8787"], true),
    lab("ls3a", g(2), midY - 26, ["voice jobs"], true),
    lab("ls3b", g(2), midY + 10, ["direct :8787"], true),
    lab("lo0", tgEnd + 12, laneTg - 22, ["Bot API polling"]),
    lab("lo1", cx[1] + 12, laneRss - 22, ["RSS every 30 min"]),
    lab("lo2", ogX + 12, laneRss - 22, ["GLM digest + translation"]),
    lab("lo3", cx[3] + 12, laneRss - 22, ["Deepgram STT"]),
  ].join("");
  const svg = `<svg class="wires" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${marker(t)}
    ${wires.map((w) => `<path data-wire data-from="${w.from}" data-to="${w.to}" d="${w.d}" fill="none" stroke="${t.arrow}" stroke-width="2" stroke-linejoin="round" marker-end="url(#ah)"/>`).join("")}
  </svg>`;
  const panel = (id, top, h, title) => `<div class="panel" style="left:32px;top:${top}px;width:${W - 64}px;height:${h}px"></div>
    <div class="ptitle" data-box data-id="${id}" style="left:50px;top:${top + 14}px">${esc(title)}</div>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css(t, W, H)}</style></head><body>
    ${panel("pt1", Y.p1, Y.sh + 56, "Run by SIERA")}
    ${panel("pt2", Y.p2, Y.oh + 56, "Third-party services")}
    ${panel("pt3", Y.p3, Y.plh + 56, "Planned hardening · not built yet")}
    ${svg}${users}${services}${cf}${third}${planned}${labels}${chips}${legend}
  </body></html>`;
  return { W, H, html };
}

// ── Checks run inside the page ─────────────────────────────────────────────────────────────────────
function pageChecks(pageBg) {
  const issues = [];
  const boxes = [...document.querySelectorAll("[data-box]")].map((el) => ({ el, id: el.dataset.id, r: el.getBoundingClientRect() }));
  const W = document.documentElement.clientWidth, H = document.documentElement.clientHeight;
  const inter = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  for (const b of boxes) if (b.r.left < 0 || b.r.top < 0 || b.r.right > W || b.r.bottom > H) issues.push(`${b.id} leaves the canvas`);
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) if (inter(boxes[i].r, boxes[j].r)) issues.push(`${boxes[i].id} overlaps ${boxes[j].id}`);
  for (const el of document.querySelectorAll(".card, .card *, .label, .ptitle, .chip")) {
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== "visible") issues.push(`clipped: ${el.className || el.tagName} "${el.textContent.trim().slice(0, 40)}"`);
  }
  for (const card of document.querySelectorAll(".card")) {
    const cr = card.getBoundingClientRect();
    for (const ch of card.querySelectorAll("*")) {
      const r = ch.getBoundingClientRect();
      if (r.width && (r.right > cr.right - 6 || r.bottom > cr.bottom - 6)) issues.push(`runs out of its card: "${ch.textContent.trim().slice(0, 40)}"`);
    }
  }
  // Connectors must not cross any box other than the two they join.
  for (const p of document.querySelectorAll("[data-wire]")) {
    const len = p.getTotalLength();
    for (let s = 6; s < len - 6; s += 3) {
      const pt = p.getPointAtLength(s);
      const hit = boxes.find((b) => ![p.dataset.from, p.dataset.to].includes(b.id) && pt.x > b.r.left - 2 && pt.x < b.r.right + 2 && pt.y > b.r.top - 2 && pt.y < b.r.bottom + 2);
      if (hit) { issues.push(`wire ${p.dataset.from}→${p.dataset.to} crosses ${hit.id}`); break; }
    }
  }
  // Connectors must not cross each other (they may share a start point).
  const wires = [...document.querySelectorAll("[data-wire]")].map((p) => {
    const pts = [];
    for (let s = 0; s <= p.getTotalLength(); s += 2) pts.push(p.getPointAtLength(s));
    return { p, pts };
  });
  for (let i = 0; i < wires.length; i++)
    for (let j = i + 1; j < wires.length; j++) {
      const a = wires[i], b = wires[j];
      if (a.p.dataset.from === b.p.dataset.from) continue;
      if (a.pts.some((u) => b.pts.some((v) => Math.abs(u.x - v.x) < 1.5 && Math.abs(u.y - v.y) < 1.5))) issues.push(`wire ${a.p.dataset.from}→${a.p.dataset.to} crosses wire ${b.p.dataset.from}→${b.p.dataset.to}`);
    }
  // Contrast of every text run against the composited background behind it.
  const parse = (c) => {
    const hex = c.match(/^#([0-9a-f]{6})$/i);
    if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1);
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1];
  };
  const over = (top, bottom) => [0, 1, 2].map((k) => top[k] * top[3] + bottom[k] * (1 - top[3])).concat(1);
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const page = parse(pageBg);
  let worst = { ratio: 99, text: "" };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent.trim()) continue;
    const el = node.parentElement;
    const layers = [];
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const bg = parse(getComputedStyle(e).backgroundColor);
      if (bg && bg[3] > 0) layers.push(bg);
    }
    const r = el.getBoundingClientRect();
    let bg = page;
    for (const pn of document.querySelectorAll(".panel")) if (inter(pn.getBoundingClientRect(), r)) bg = over(parse(getComputedStyle(pn).backgroundColor), bg);
    for (const l of layers.reverse()) bg = over(l, bg);
    const fg = over(parse(getComputedStyle(el).color), bg);
    const a = lum(fg), b = lum(bg);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (ratio < worst.ratio) worst = { ratio, text: node.textContent.trim().slice(0, 40) };
    if (ratio < 4.5) issues.push(`contrast ${ratio.toFixed(2)}:1 for "${node.textContent.trim().slice(0, 40)}"`);
  }
  return { issues, worst, font: document.fonts.check("16px InterV"), boxes: boxes.length };
}

// ── Render ──────────────────────────────────────────────────────────────────────────────────────────
let sharp = null;
try { sharp = require("sharp"); } catch { /* optional: without sharp the PNGs are only larger */ }

const browser = await chromium.launch();
let failed = 0;
for (const [themeName, t] of Object.entries(THEMES)) {
  const { W, H, html } = architecture(t);
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.load("16px InterV"));
  await page.evaluate(() => document.fonts.ready);
  const res = await page.evaluate(pageChecks, t.page);
  const out = path.join(OUT, `architecture-${themeName}.png`);
  console.log(`${path.basename(out)}: ${res.boxes} boxes, Inter loaded: ${res.font}, worst contrast ${res.worst.ratio.toFixed(2)}:1 ("${res.worst.text}")`);
  if (res.issues.length || !res.font) {
    res.issues.forEach((i) => console.log(`  ✗ ${i}`));
    failed++;
  } else {
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: W, height: H } });
    const buf = sharp ? await sharp(png).png({ palette: true, quality: 92, effort: 10, compressionLevel: 9 }).toBuffer() : png;
    writeFileSync(out, buf);
    console.log(`  wrote ${W * 2}x${H * 2}, ${(buf.length / 1024).toFixed(0)} KB`);
  }
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
