// The island page is self-contained: the window loads it as a data URL, and it talks to the
// main process only through the `t3Island` bridge from island-preload.
// Motion runs on state changes and on the shared 1 Hz tick; nothing repaints continuously.

const STYLE = `
:root {
  --bg: #000;
  --fg: rgba(255, 255, 255, 0.95);
  --fg2: rgba(255, 255, 255, 0.6);
  --fg3: rgba(255, 255, 255, 0.4);
  --line: rgba(255, 255, 255, 0.1);
  --hover: rgba(255, 255, 255, 0.075);
  --press: rgba(255, 255, 255, 0.12);
  --working: #a7adff;
  --attention: #ffc94d;
  --failed: #ff7070;
  --limited: #ffa24f;
  --done: #5ad694;
  --spring: cubic-bezier(0.32, 1.28, 0.54, 1);
  --ease: cubic-bezier(0.32, 0.72, 0, 1);
  --bar: 26px;
  --top: 2px;
  --w: 26px;
  --h: 26px;
  --ear: 96px;
  --title: 128px;
  --radius: 13px;
  color-scheme: dark;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: transparent;
  user-select: none;
  -webkit-user-select: none;
  cursor: default;
}
body {
  color: var(--fg);
  font: 13px/1.25 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
  -webkit-font-smoothing: antialiased;
  letter-spacing: -0.005em;
}
button { font: inherit; color: inherit; background: none; border: 0; text-align: left; cursor: default; }

[data-tone="working"] { --tone: var(--working); }
[data-tone="attention"] { --tone: var(--attention); }
[data-tone="failed"] { --tone: var(--failed); }
[data-tone="limited"] { --tone: var(--limited); }
[data-tone="done"] { --tone: var(--done); }
[data-tone="rest"] { --tone: rgba(255, 255, 255, 0.58); }

/* Shell: the shape. It carries the size; the island inside clips to it. */
.shell {
  position: absolute;
  top: var(--top);
  left: 0;
  right: 0;
  margin-inline: auto;
  width: var(--w);
  height: var(--h);
  transform-origin: 50% 0;
  transition:
    width 0.5s var(--spring),
    height 0.5s var(--spring),
    top 0.4s var(--ease),
    opacity 0.32s var(--ease),
    transform 0.5s var(--spring);
}
.island {
  position: absolute;
  inset: 0;
  /* clip, not hidden: focusing a button must not scroll the shape's content out of place. */
  overflow: clip;
  background: var(--bg);
  border-radius: var(--radius);
  transition: border-radius 0.5s var(--spring), box-shadow 0.4s var(--ease);
}
.shell[data-shape="pill"] .island {
  box-shadow:
    0 0 0 0.5px rgba(255, 255, 255, 0.13) inset,
    0 3px 10px rgba(0, 0, 0, 0.28);
}
.shell[data-shape="pill"][data-expanded] .island {
  box-shadow:
    0 0 0 0.5px rgba(255, 255, 255, 0.12) inset,
    0 22px 48px -8px rgba(0, 0, 0, 0.6),
    0 6px 16px rgba(0, 0, 0, 0.3);
}
.shell[data-shape="notch"][data-expanded] .island { box-shadow: 0 22px 48px -8px rgba(0, 0, 0, 0.6); }
.shell[data-hidden] { pointer-events: none; }
.shell[data-shape="pill"][data-hidden] { opacity: 0; transform: scale(0.6); }

/* Concave corners that blend the notch into the menu bar. */
.flare { position: absolute; top: 0; width: 8px; height: 8px; display: none; }
.flare.l { left: -8px; background: radial-gradient(circle at 0 100%, transparent 7.5px, var(--bg) 8px); }
.flare.r { right: -8px; background: radial-gradient(circle at 100% 100%, transparent 7.5px, var(--bg) 8px); }
.shell[data-shape="notch"] .flare { display: block; }

/* Bar: the strip at the island's top, as tall as the collapsed island. */
.bar { position: relative; height: var(--bar); }
.face {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 4px 0 5px;
  transition: opacity 0.2s var(--ease), transform 0.36s var(--spring), filter 0.2s var(--ease);
}
.shell[data-shape="notch"] .face { padding: 0 10px 0 12px; }
.lead, .trail { display: flex; align-items: center; flex: none; min-width: 0; }
.lead { gap: 7px; }
.trail { gap: 7px; }
.shell[data-shape="notch"] .header .lead,
.shell[data-shape="notch"] .header .trail { max-width: var(--ear); }
.shell[data-shape="notch"] .trail { justify-content: flex-end; }

.compact[data-swap] { opacity: 0; filter: blur(3px); transform: scale(0.96); }
.shell[data-expanded] .compact { opacity: 0; filter: blur(4px); transform: translateY(-3px) scale(0.97); pointer-events: none; }
.header { opacity: 0; filter: blur(4px); transform: translateY(3px) scale(0.97); pointer-events: none; padding-left: 12px; padding-right: 10px; }
.shell[data-expanded] .header { opacity: 1; filter: none; transform: none; pointer-events: auto; transition-delay: 0.06s; }
.shell[data-hidden] .face { opacity: 0; }
.shell:not([data-hidden]) .compact:not([data-swap]) { transition-delay: 0.08s; }

.title {
  max-width: var(--title);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-weight: 600;
  font-size: 13px;
}
.ear-label, .ear-meta { display: none; }
.shell[data-shape="notch"] .compact .title,
.shell[data-shape="notch"] .compact .chip { display: none; }
.shell[data-shape="notch"] .compact .ear-label { display: block; color: var(--tone); font-size: 12.5px; font-weight: 650; white-space: nowrap; }
.shell[data-shape="notch"] .compact .ear-meta:not(:empty) { display: block; color: var(--tone); opacity: 0.82; font-size: 12.5px; font-weight: 550; font-variant-numeric: tabular-nums; white-space: nowrap; }

.brand { font-size: 12px; font-weight: 600; color: var(--fg2); letter-spacing: 0; white-space: nowrap; }
.brand b { color: var(--fg); font-weight: 650; }

/* Orbs: a status glyph; working ones are rings that step round on the tick. */
.orb { position: relative; flex: none; width: 16px; height: 16px; color: var(--tone); }
.orb svg { display: block; width: 100%; height: 100%; overflow: visible; }
.orb[data-tone="working"] svg { transition: transform 0.6s var(--ease); }
.orb[data-tone="attention"] { filter: drop-shadow(0 0 5px rgba(255, 201, 77, 0.5)); }
.orb[data-tone="failed"] { filter: drop-shadow(0 0 5px rgba(255, 112, 112, 0.45)); }
.shell[data-shape="notch"] .compact .orb { width: 17px; height: 17px; }
.stack { display: flex; align-items: center; flex: none; }

.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: calc(var(--bar) - 8px);
  padding: 0 9px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--tone) 17%, transparent);
  color: var(--tone);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  transition: background 0.3s var(--ease), color 0.3s var(--ease);
}
.chip-meta { font-weight: 500; opacity: 0.75; font-variant-numeric: tabular-nums; }
.chip-meta:empty { display: none; }

/* Counters: how many threads sit in each other group, e.g. three working and one done. */
.counters { display: flex; align-items: center; gap: 7px; }
.counter {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--tone);
  font-size: 11.5px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.counter svg { width: 11px; height: 11px; display: block; }

.summary { display: flex; gap: 6px; align-items: center; }
.tally {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 18px;
  padding: 0 7px 0 6px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.07);
  color: var(--fg2);
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.tally i { width: 6px; height: 6px; border-radius: 50%; background: var(--tone); }

/* Panel: the open list under the bar. */
.panel {
  position: absolute;
  top: var(--bar);
  left: 0;
  right: 0;
  padding: 2px 6px 7px;
  opacity: 0;
  transform: translateY(-6px);
  transition: opacity 0.18s var(--ease), transform 0.4s var(--spring);
}
.shell[data-expanded] .panel { opacity: 1; transform: none; transition-delay: 0.08s; }
.panel::before { content: ""; position: absolute; top: 0; left: 14px; right: 14px; height: 0.5px; background: var(--line); }
.list { overflow-y: auto; scrollbar-width: none; padding-top: 2px; }
.list::-webkit-scrollbar { display: none; }

.section {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 10px 3px 12px;
  color: var(--fg3);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.01em;
}
.section i { width: 5px; height: 5px; border-radius: 50%; background: var(--tone); }
.section b { font-weight: 600; color: var(--fg3); opacity: 0.8; font-variant-numeric: tabular-nums; }

.row {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  min-height: 48px;
  padding: 6px 10px 6px 9px;
  border-radius: 14px;
  transition: background 0.16s var(--ease);
}
.row:hover { background: var(--hover); }
.row:active { background: var(--press); }
.row .orb { width: 26px; height: 26px; }
.row-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.row-title, .row-sub { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.row-title { font-size: 13px; font-weight: 600; }
.row-sub { font-size: 11.5px; color: var(--fg3); }
.row-sub .state { color: var(--tone); font-weight: 600; }
.row-sub .detail { color: var(--fg2); }
.row-sub .sep { margin: 0 5px; opacity: 0.6; }
.row-end { flex: none; display: flex; align-items: center; gap: 4px; }
.row-meta { font-size: 12px; color: var(--fg2); font-variant-numeric: tabular-nums; }
.row-go {
  width: 14px;
  height: 14px;
  margin-right: -4px;
  color: var(--fg3);
  opacity: 0;
  transform: translateX(-4px);
  transition: opacity 0.16s var(--ease), transform 0.24s var(--ease);
}
.row:hover .row-go { opacity: 1; transform: none; }

/* Stop: a round button that replaces the timer on hover, then asks once more. */
.stop {
  display: none;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 24px;
  min-width: 24px;
  padding: 0;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.1);
  color: var(--fg);
  font-size: 11.5px;
  font-weight: 600;
  white-space: nowrap;
  transition: background 0.16s var(--ease), padding 0.2s var(--ease);
}
.stop i { width: 8px; height: 8px; border-radius: 2px; background: currentColor; }
.stop:hover { background: rgba(255, 255, 255, 0.16); }
.row:hover .stop, .stop[data-armed], .stop[data-busy] { display: inline-flex; }
.row:hover .stop + .row-go, .row:hover [data-stoppable] { display: none; }
.stop[data-armed] { padding: 0 10px 0 8px; background: color-mix(in srgb, var(--failed) 22%, transparent); color: var(--failed); }
.stop[data-busy] { padding: 0 10px; background: rgba(255, 255, 255, 0.08); color: var(--fg2); }
.stop[data-busy] i { display: none; }
.item[data-stopping] .row-meta { display: none; }

/* Cards: what the agent waits on, answered in place. */
.card {
  margin: -2px 10px 6px 46px;
  padding: 9px 11px 10px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.055);
}
.card-label { font-size: 11.5px; color: var(--fg2); font-weight: 600; }
.card-body {
  margin-top: 5px;
  color: var(--fg);
  font: 11.5px/1.45 ui-monospace, "SF Mono", Menlo, monospace;
  word-break: break-all;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-question { font-size: 12.5px; line-height: 1.4; color: var(--fg); font-weight: 500; }
.card-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
.card-options { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.card-note { margin-top: 8px; font-size: 11.5px; color: var(--fg2); }
.card-note[data-error] { color: var(--failed); }
.btn {
  height: 26px;
  padding: 0 12px;
  border-radius: 13px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  background: rgba(255, 255, 255, 0.09);
  color: var(--fg);
  transition: background 0.16s var(--ease), transform 0.12s var(--ease), filter 0.16s var(--ease);
}
.btn:hover { background: rgba(255, 255, 255, 0.15); }
.btn:active { transform: scale(0.97); }
.btn[data-primary] { background: var(--tone); color: #000; }
.btn[data-primary]:hover { filter: brightness(1.08); }
.opt {
  max-width: 100%;
  min-height: 26px;
  padding: 4px 11px;
  border-radius: 13px;
  font-size: 12px;
  font-weight: 550;
  background: transparent;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16);
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: background 0.16s var(--ease), box-shadow 0.16s var(--ease);
}
.opt:hover { background: color-mix(in srgb, var(--tone) 16%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 55%, transparent); }

/* Rest: the small island kept in the menu bar when nothing is going on. */
/* Bare: a resting island with no history to show keeps only its standby icon. */
.shell[data-shape="pill"][data-bare] .compact { justify-content: center; padding: 0; }
.shell[data-bare] .title, .shell[data-bare] .ear-label, .shell[data-bare] .trail { display: none; }

.gear {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  margin-right: -4px;
  border-radius: 11px;
  color: var(--fg3);
  transition: background 0.16s var(--ease), color 0.16s var(--ease);
}
.gear:hover { background: rgba(255, 255, 255, 0.1); color: var(--fg); }
.gear svg { width: 14px; height: 14px; display: block; }


@keyframes nudge {
  0% { transform: scale(1); }
  30% { transform: scale(1.06); }
  62% { transform: scale(0.985); }
  100% { transform: scale(1); }
}
.shell[data-nudge] { animation: nudge 0.62s var(--ease); }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0.01ms !important; animation: none !important; }
}
`;

const SCRIPT = `
(function () {
  var bridge = window.t3Island;
  var STRINGS = {
    en: {
      approval: "Approval", input: "Needs input", request: "Guest message", failed: "Failed",
      limited: "Usage limit", working: "Working", done: "Done", now: "now",
      minutes: function (n) { return n + "m ago"; }, hours: function (n) { return n + "h ago"; },
      days: function (n) { return n + "d ago"; }, untitled: "Untitled thread",
      many: {
        attention: function (n) { return n + " need you"; }, failed: function (n) { return n + " failed"; },
        working: function (n) { return n + " working"; }, done: function (n) { return n + " done"; }
      },
      section: { attention: "Needs you", failed: "Failed", working: "Working", done: "Just finished" },
      ask: {
        command: "Wants to run", "file-read": "Wants to read", "file-change": "Wants to edit",
        "mcp-elicitation": "Asks for", permission: "Asks for permission", dynamic_tool_call: "Wants to call",
        other: "Needs your approval"
      },
      decision: {
        accept: "Allow", acceptForSession: "Allow for session", acceptAlways: "Always allow",
        decline: "Decline", cancel: "Cancel"
      },
      stop: "Stop", confirmStop: "Stop?", stopping: "Stopping…", sending: "Sending…",
      noEffect: "That didn't go through. Open the thread to handle it.", answerInT3: "Answer in T3",
      rest: "Last finished", settings: "Island settings"
    },
    zh: {
      approval: "待批准", input: "等你回答", request: "访客消息", failed: "失败",
      limited: "额度用尽", working: "处理中", done: "已完成", now: "刚刚",
      minutes: function (n) { return n + " 分钟前"; }, hours: function (n) { return n + " 小时前"; },
      days: function (n) { return n + " 天前"; }, untitled: "未命名会话",
      many: {
        attention: function (n) { return n + " 个待处理"; }, failed: function (n) { return n + " 个出错"; },
        working: function (n) { return n + " 个进行中"; }, done: function (n) { return n + " 个已完成"; }
      },
      section: { attention: "需要你处理", failed: "出错了", working: "进行中", done: "刚完成" },
      ask: {
        command: "要运行命令", "file-read": "要读取文件", "file-change": "要修改文件",
        "mcp-elicitation": "要向你请求", permission: "要申请权限", dynamic_tool_call: "要调用工具",
        other: "需要你批准"
      },
      decision: {
        accept: "允许", acceptForSession: "本会话都允许", acceptAlways: "总是允许",
        decline: "拒绝", cancel: "取消"
      },
      stop: "停止", confirmStop: "确认停止", stopping: "正在停止…", sending: "正在提交…",
      noEffect: "没有生效，请打开会话处理", answerInT3: "去 T3 回答",
      rest: "上次完成", settings: "状态岛设置"
    }
  };
  var TONE = { rest: "rest", idle: "rest", approval: "attention", input: "attention", request: "attention", failed: "failed",
    limited: "limited", working: "working", done: "done" };
  var GROUP = { rest: "done", approval: "attention", input: "attention", request: "attention", failed: "failed",
    limited: "failed", working: "working", done: "done" };
  var GROUP_ORDER = ["attention", "failed", "working", "done"];
  var GLYPH = {
    approval: '<path d="M10 5.6v5" stroke="#000" stroke-width="2.3" stroke-linecap="round"/><circle cx="10" cy="14.1" r="1.35" fill="#000"/>',
    input: '<path d="M7.75 7.9a2.35 2.35 0 1 1 3.4 2.1c-.75.38-1.15.86-1.15 1.62v.2" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="14.6" r="1.2" fill="#000"/>',
    request: '<circle cx="6.4" cy="10" r="1.35" fill="#000"/><circle cx="10" cy="10" r="1.35" fill="#000"/><circle cx="13.6" cy="10" r="1.35" fill="#000"/>',
    failed: '<path d="M7.2 7.2l5.6 5.6M12.8 7.2l-5.6 5.6" stroke="#000" stroke-width="2.2" stroke-linecap="round"/>',
    limited: '<path d="M10 5.9V10l2.7 1.7" fill="none" stroke="#000" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>',
    done: '<path d="M6.3 10.3l2.55 2.5 4.85-5.3" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'
  };
  var MINI = {
    attention: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="6" fill="currentColor"/><path d="M6 3.2v3.2" stroke="#000" stroke-width="1.6" stroke-linecap="round"/><circle cx="6" cy="8.7" r=".9" fill="#000"/></svg>',
    failed: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="6" fill="currentColor"/><path d="M4.2 4.2l3.6 3.6M7.8 4.2l-3.6 3.6" stroke="#000" stroke-width="1.5" stroke-linecap="round"/></svg>',
    working: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-opacity=".38" stroke-width="1.8"/><path d="M6 1.4a4.6 4.6 0 0 1 4.6 4.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    done: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="6" fill="currentColor"/><path d="M3.6 6.2l1.6 1.6 3.2-3.5" fill="none" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };
  var CHEVRON = '<svg viewBox="0 0 14 14"><path d="M5.5 3.5L9 7l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var PILL_MAX_WIDTH = 284;
  var ACTION_TIMEOUT_MS = 8000;

  var $ = function (id) { return document.getElementById(id); };
  var shell = $("shell"), compact = $("compact"), panel = $("panel"), list = $("list");
  var cLead = $("c-lead"), cTitle = $("c-title"), cEarLabel = $("c-ear-label"), cCounters = $("c-counters"),
    cChip = $("c-chip"), cLabel = $("c-label"), cMeta = $("c-meta"), cEarMeta = $("c-ear-meta"),
    cTrail = $("c-trail"), summary = $("summary");
  var root = document.documentElement;

  var items = [];
  var prefs = { idleVisible: false, expandOn: "hover", onFullScreen: true, motion: true };
  var BARE_WIDTH = 40;
  var recent = null, bare = false, resting = false;
  var GEAR = '<svg viewBox="0 0 16 16"><path d="M8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8Z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6.9 1.8h2.2l.35 1.6 1.2.7 1.55-.5 1.1 1.9-1.2 1.1v1.4l1.2 1.1-1.1 1.9-1.55-.5-1.2.7-.35 1.6H6.9l-.35-1.6-1.2-.7-1.55.5-1.1-1.9 1.2-1.1V7.3L2.7 6.2l1.1-1.9 1.55.5 1.2-.7.35-1.6Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  var lang = "en";
  var geometry = { notch: null, menuBarHeight: 24 };
  var visible = false, expanded = false, interactive = false;
  var compactKey = "", lastPrimary = "", listKey = "";
  var seenDone = null, flash = null;
  var ui = {};
  var armedAt = 0;
  var angle = 0;
  var tickTimer = null, hoverTimer = null, leaveTimer = null, swapTimer = null, flashTimer = null;

  function t(key) { return (STRINGS[lang] || STRINGS.en)[key]; }
  function keyOf(item) { return item.environmentId + "/" + item.threadId; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function text(el, value) { if (el.textContent !== value) el.textContent = value; }
  function setFlag(el, name, on) { if (on) el.setAttribute(name, ""); else el.removeAttribute(name); }
  function el(tag, cls, content) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (content !== undefined) node.textContent = content;
    return node;
  }
  function find(key) {
    for (var i = 0; i < items.length; i++) if (keyOf(items[i]) === key) return items[i];
    return null;
  }

  // Orbs ----------------------------------------------------------------------
  function orbSvg(status, phase) {
    if (status.indexOf("multi:") === 0) {
      // Several threads at work: one ring cut into a segment per thread.
      var count = clamp(Number(status.slice(6)) || 2, 2, 4);
      var segment = (47.75 / count - 5.2).toFixed(2);
      return '<svg viewBox="0 0 20 20" style="transform: rotate(' + (angle + phase) + 'deg)">' +
        '<circle cx="10" cy="10" r="7.6" fill="none" stroke="currentColor" stroke-opacity=".18" stroke-width="2.3"/>' +
        '<circle cx="10" cy="10" r="7.6" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-dasharray="' +
        segment + " " + (47.75 / count - Number(segment)).toFixed(2) + '" transform="rotate(-90 10 10)"/>' +
        "</svg>";
    }
    if (status === "working") {
      return '<svg viewBox="0 0 20 20" style="transform: rotate(' + (angle + phase) + 'deg)">' +
        '<circle cx="10" cy="10" r="7.6" fill="none" stroke="currentColor" stroke-opacity=".24" stroke-width="2.3"/>' +
        '<circle cx="10" cy="10" r="7.6" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-dasharray="13 48" transform="rotate(-90 10 10)"/>' +
        "</svg>";
    }
    if (status === "idle") {
      return '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.6" fill="none" stroke="currentColor" stroke-width="2.1"/>' +
        '<circle cx="10" cy="10" r="2.2" fill="currentColor"/></svg>';
    }
    var glyph = status === "rest" ? GLYPH.done : GLYPH[status];
    return '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="10" fill="currentColor"/>' + (glyph || "") + "</svg>";
  }
  function orb(status, phase) {
    var node = el("span", "orb");
    node.dataset.tone = TONE[status] || "working";
    node.dataset.phase = String(phase || 0);
    node.innerHTML = orbSvg(status, phase || 0);
    return node;
  }

  // Time ----------------------------------------------------------------------
  function pad(n) { return n < 10 ? "0" + n : String(n); }
  function elapsed(since, now) {
    var s = Math.max(0, Math.floor((now - since) / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h > 0 ? h + ":" + pad(m) + ":" + pad(r) : m + ":" + pad(r);
  }
  function ago(since, now) {
    var s = Math.max(0, Math.floor((now - since) / 1000));
    if (s < 60) return t("now");
    if (s < 3600) return t("minutes")(Math.floor(s / 60));
    if (s < 86400) return t("hours")(Math.floor(s / 3600));
    return t("days")(Math.floor(s / 86400));
  }
  function timeLabel(item, now) {
    if (item.since === null || item.since === undefined) return "";
    return item.status === "working" ? elapsed(item.since, now) : ago(item.since, now);
  }

  // Groups --------------------------------------------------------------------
  function groupsOf(list) {
    var byId = {};
    list.forEach(function (item) {
      var id = GROUP[item.status] || "working";
      (byId[id] = byId[id] || []).push(item);
    });
    return GROUP_ORDER.filter(function (id) { return byId[id]; }).map(function (id) {
      var members = byId[id];
      var allLimited = members.every(function (item) { return item.status === "limited"; });
      var allRest = members.every(function (item) { return item.status === "rest"; });
      var tone = id === "failed" ? (allLimited ? "limited" : "failed") : id === "done" && allRest ? "rest" : id;
      return { id: id, tone: tone, items: members };
    });
  }

  /** What the collapsed island says: its most urgent group, then counts of the rest. */
  function compactModel(now) {
    var groups = groupsOf(items);
    if (groups.length === 0) return null;
    var primary = groups[0];
    var flashed = flash && flash.until > now ? find(flash.key) : null;
    if (flashed && (primary.id === "working" || primary.id === "done")) {
      primary = { id: "done", tone: "done", items: [flashed], flash: true };
    }
    var shown = {};
    primary.items.forEach(function (item) { shown[keyOf(item)] = true; });
    var counters = groupsOf(items.filter(function (item) { return !shown[keyOf(item)]; }));
    var single = primary.items.length === 1 ? primary.items[0] : null;
    return {
      primary: primary,
      single: single,
      orb: single
        ? single.status
        : primary.id === "working"
          ? "multi:" + primary.items.length
          : primary.items[0].status,
      title: single
        ? single.title || t("untitled")
        : primary.items.map(function (item) { return item.title || t("untitled"); }).join(" · "),
      label: single ? t(single.status) : t("many")[primary.id](primary.items.length),
      meta: !single ? "" : single.status === "working" ? elapsed(single.since || now, now)
        : single.status === "rest" ? timeLabel(single, now) : "",
      earMeta: single ? timeLabel(single, now) : "",
      counters: counters.map(function (group) { return { id: group.id, tone: group.tone, count: group.items.length }; })
    };
  }

  // Geometry ------------------------------------------------------------------
  function barHeight() {
    return geometry.notch ? geometry.notch.height : clamp(geometry.menuBarHeight - 2, 22, 30);
  }
  function applyGeometry() {
    var notch = geometry.notch;
    var bar = barHeight();
    shell.dataset.shape = notch ? "notch" : "pill";
    root.style.setProperty("--bar", bar + "px");
    root.style.setProperty("--top", (notch ? 0 : Math.max(0, Math.round((geometry.menuBarHeight - bar) / 2))) + "px");
    var w, h, r;
    if (!visible) {
      w = notch ? notch.width : bar;
      h = bar;
      r = notch ? "0 0 " + Math.round(bar * 0.36) + "px " + Math.round(bar * 0.36) + "px" : bar / 2 + "px";
    } else if (!expanded && bare) {
      w = notch ? notch.width + 2 * BARE_WIDTH : BARE_WIDTH;
      h = bar;
      r = notch ? "0 0 " + Math.round(bar * 0.36) + "px " + Math.round(bar * 0.36) + "px" : bar / 2 + "px";
    } else if (!expanded) {
      var trail = cTrail.offsetWidth;
      if (notch) {
        var lead = cLead.offsetWidth;
        var ear = clamp(Math.max(lead + 18, trail + 16), 64, 132);
        w = notch.width + ear * 2;
        r = "0 0 " + Math.round(bar * 0.42) + "px " + Math.round(bar * 0.42) + "px";
      } else {
        var orbs = cLead.querySelector(".stack").offsetWidth;
        var room = PILL_MAX_WIDTH - (5 + orbs + 7 + 16 + trail + 4);
        root.style.setProperty("--title", clamp(room, 48, 150) + "px");
        w = clamp(5 + cLead.offsetWidth + 16 + trail + 4, 120, PILL_MAX_WIDTH);
        r = bar / 2 + "px";
      }
      h = bar;
    } else {
      w = notch ? Math.max(400, notch.width + 228) : 392;
      var maxList = window.innerHeight - bar - (notch ? 0 : 4) - 34;
      list.style.maxHeight = maxList + "px";
      h = bar + Math.min(panel.scrollHeight, maxList + 12);
      r = notch ? "0 0 26px 26px" : "22px";
      if (notch) root.style.setProperty("--ear", (w - notch.width) / 2 - 14 + "px");
    }
    root.style.setProperty("--w", Math.round(w) + "px");
    root.style.setProperty("--h", Math.round(h) + "px");
    root.style.setProperty("--radius", r);
  }

  // Compact bar ---------------------------------------------------------------
  function paintCompact(model) {
    var stack = el("span", "stack");
    stack.appendChild(orb(model.orb, 0));
    cLead.replaceChild(stack, cLead.querySelector(".stack"));
    text(cTitle, model.title);
    cTrail.dataset.tone = model.primary.tone;
    cChip.dataset.tone = model.primary.tone;
    cEarLabel.dataset.tone = model.primary.tone;
    text(cLabel, model.label);
    text(cEarLabel, model.label);
    text(cMeta, model.meta);
    text(cEarMeta, model.counters.length ? "" : model.earMeta);
    cCounters.innerHTML = model.counters.map(function (counter) {
      return '<span class="counter" data-tone="' + counter.tone + '">' + MINI[counter.id] + counter.count + "</span>";
    }).join("");
    applyGeometry();
  }

  function renderCompact(now, animate) {
    var model = compactModel(now);
    if (!model) return;
    var key = [lang, model.primary.id, model.primary.flash ? "flash" : "", model.title, model.label,
      model.orb, model.counters.map(function (c) { return c.id + c.count; }).join(",")].join("|");
    if (key === compactKey) {
      text(cMeta, model.meta);
      text(cEarMeta, model.counters.length ? "" : model.earMeta);
      return;
    }
    var primaryKey = model.primary.id + ":" + model.primary.items.map(keyOf).join(",");
    var nudge = (model.primary.id === "attention" || model.primary.flash) && primaryKey !== lastPrimary;
    compactKey = key;
    lastPrimary = primaryKey;
    clearTimeout(swapTimer);
    if (!animate || expanded) {
      paintCompact(model);
    } else {
      compact.setAttribute("data-swap", "");
      swapTimer = setTimeout(function () {
        paintCompact(model);
        compact.removeAttribute("data-swap");
      }, 130);
    }
    if (nudge && visible && prefs.motion) {
      shell.removeAttribute("data-nudge");
      void shell.offsetWidth;
      shell.setAttribute("data-nudge", "");
    }
  }

  // Header and list -----------------------------------------------------------
  function renderSummary() {
    var html = resting ? "" : groupsOf(items).map(function (group) {
      return '<span class="tally" data-tone="' + group.tone + '"><i></i>' + group.items.length + "</span>";
    }).join("");
    if (summary.innerHTML !== html) summary.innerHTML = html;
  }

  function armed() { return Date.now() >= armedAt; }

  function act(item, action) {
    if (!bridge || !armed()) return false;
    action.environmentId = item.environmentId;
    action.threadId = item.threadId;
    bridge.act(action);
    return true;
  }

  function startPending(item, label) {
    var key = keyOf(item);
    var requestId = item.request ? item.request.requestId : null;
    ui[key] = { pending: { label: label, requestId: requestId, status: item.status, until: Date.now() + ACTION_TIMEOUT_MS } };
    setTimeout(function () {
      var state = ui[key];
      if (!state || !state.pending || state.pending.until > Date.now()) return;
      ui[key] = { error: true };
      renderList(Date.now(), true);
      setTimeout(function () {
        if (ui[key] && ui[key].error) { delete ui[key]; renderList(Date.now(), true); }
      }, 4500);
    }, ACTION_TIMEOUT_MS + 50);
    renderList(Date.now(), true);
  }

  /** A pending action ends when the thread moves on: its request resolved or its run stopped. */
  function settleUi() {
    Object.keys(ui).forEach(function (key) {
      var state = ui[key];
      if (!state.pending) return;
      var item = find(key);
      var requestId = item && item.request ? item.request.requestId : null;
      if (!item || item.status !== state.pending.status || requestId !== state.pending.requestId) delete ui[key];
    });
  }

  function cardFor(item) {
    var request = item.request;
    var state = ui[keyOf(item)] || {};
    if (!request && !state.error) return null;
    var card = el("div", "card");
    card.dataset.tone = "attention";
    card.addEventListener("click", function (event) { event.stopPropagation(); });
    if (request && request.kind === "approval") {
      var asks = t("ask");
      card.appendChild(el("div", "card-label", asks[request.action] || asks.other));
      if (request.body) card.appendChild(el("div", "card-body", request.body));
    } else if (request && request.kind === "input") {
      card.appendChild(el("div", "card-question", request.question));
    }
    if (state.pending) {
      card.appendChild(el("div", "card-note", state.pending.label));
      return card;
    }
    if (state.error) {
      var note = el("div", "card-note", t("noEffect"));
      note.setAttribute("data-error", "");
      card.appendChild(note);
      return card;
    }
    if (request.kind === "approval") {
      var actions = el("div", "card-actions");
      var names = t("decision");
      var last = request.decisions.length - 1;
      request.decisions.forEach(function (decision, index) {
        var button = el("button", "btn", names[decision] || decision);
        if (index === last && decision.indexOf("accept") === 0) button.setAttribute("data-primary", "");
        button.addEventListener("click", function (event) {
          event.stopPropagation();
          if (act(item, { type: "approve", requestId: request.requestId, decision: decision })) {
            startPending(item, t("sending"));
          }
        });
        actions.appendChild(button);
      });
      card.appendChild(actions);
    } else if (request.kind === "input") {
      if (request.options.length > 0 && request.direct) {
        var options = el("div", "card-options");
        request.options.forEach(function (option) {
          var button = el("button", "opt", option.label);
          if (option.description) button.title = option.description;
          button.addEventListener("click", function (event) {
            event.stopPropagation();
            var answer = { type: "answer", requestId: request.requestId, questionId: request.questionId, answer: option.value };
            if (act(item, answer)) startPending(item, t("sending"));
          });
          options.appendChild(button);
        });
        card.appendChild(options);
      } else {
        var go = el("div", "card-actions");
        var open = el("button", "btn", t("answerInT3"));
        open.setAttribute("data-primary", "");
        open.addEventListener("click", function (event) { event.stopPropagation(); openItem(item); });
        go.appendChild(open);
        card.appendChild(go);
      }
    }
    return card;
  }

  function stopControl(item) {
    var key = keyOf(item);
    var state = ui[key] || {};
    var button = el("button", "stop");
    button.title = t("stop");
    if (state.pending) {
      button.setAttribute("data-busy", "");
      button.textContent = state.pending.label;
      return button;
    }
    button.appendChild(el("i"));
    if (state.confirm) {
      button.setAttribute("data-armed", "");
      button.appendChild(document.createTextNode(t("confirmStop")));
    }
    button.addEventListener("click", function (event) {
      event.stopPropagation();
      var current = ui[key] || {};
      if (!current.confirm) {
        if (!armed()) return;
        ui[key] = { confirm: true };
        renderList(Date.now(), true);
        setTimeout(function () {
          if (ui[key] && ui[key].confirm) { delete ui[key]; renderList(Date.now(), true); }
        }, 3500);
        return;
      }
      if (act(item, { type: "stop" })) startPending(item, t("stopping"));
    });
    return button;
  }

  function rowFor(item, sectioned) {
    var tone = TONE[item.status] || "working";
    var wrap = el("div", "item");
    wrap.dataset.key = keyOf(item);
    var state = ui[keyOf(item)] || {};
    if (item.status === "working" && state.pending) wrap.setAttribute("data-stopping", "");
    var row = el("div", "row");
    row.dataset.tone = tone;
    row.appendChild(orb(item.status, 0));
    var body = el("span", "row-text");
    body.appendChild(el("span", "row-title", item.title || t("untitled")));
    var sub = el("span", "row-sub");
    // Under a section heading the state is already said; the line keeps what tells rows apart.
    var detail = item.detail && item.status !== "approval" && item.status !== "input" ? item.detail : null;
    var showState = !detail && (!sectioned || !item.project || GROUP[item.status] !== "working");
    if (item.project) sub.appendChild(document.createTextNode(item.project));
    if (item.project && (detail || showState)) sub.appendChild(el("span", "sep", "·"));
    if (detail) sub.appendChild(el("span", "detail", detail));
    else if (showState) sub.appendChild(el("span", "state", t(item.status)));
    body.appendChild(sub);
    row.appendChild(body);
    var end = el("span", "row-end");
    var meta = el("span", "row-meta");
    end.appendChild(meta);
    if (item.status === "working" && item.canStop) {
      meta.setAttribute("data-stoppable", "");
      end.appendChild(stopControl(item));
    }
    var go = el("span", "row-go");
    go.innerHTML = CHEVRON;
    end.appendChild(go);
    row.appendChild(end);
    row.addEventListener("click", function () { openItem(item); });
    wrap.appendChild(row);
    var card = cardFor(item);
    if (card) wrap.appendChild(card);
    return wrap;
  }

  function renderList(now, force) {
    var key = lang + "|" + JSON.stringify(items.map(function (item) {
      return [keyOf(item), item.status, item.title, item.project, item.detail, item.canStop,
        item.request ? JSON.stringify(item.request) : ""];
    }));
    if (force || key !== listKey) {
      listKey = key;
      list.textContent = "";
      var groups = groupsOf(items);
      var sections = groups.length > 1 || items.length > 3;
      groups.forEach(function (group) {
        if (sections) {
          var head = el("div", "section");
          head.dataset.tone = group.tone;
          head.appendChild(el("i"));
          head.appendChild(document.createTextNode(t("section")[group.id]));
          head.appendChild(el("b", "", String(group.items.length)));
          list.appendChild(head);
        }
        group.items.forEach(function (item) { list.appendChild(rowFor(item, sections)); });
      });
      if (expanded) applyGeometry();
    }
    var rows = list.querySelectorAll(".item");
    for (var i = 0; i < rows.length; i++) {
      var item = find(rows[i].dataset.key);
      if (item) text(rows[i].querySelector(".row-meta"), timeLabel(item, now));
    }
  }

  // Ticking -------------------------------------------------------------------
  function tick() {
    var now = Date.now();
    if (items.some(function (item) { return item.status === "working"; })) {
      angle += 90;
      var orbs = document.querySelectorAll('.orb[data-tone="working"]');
      for (var i = 0; i < orbs.length; i++) {
        var svg = orbs[i].firstChild;
        if (svg) svg.style.transform = "rotate(" + (angle + Number(orbs[i].dataset.phase || 0)) + "deg)";
      }
    }
    renderCompact(now, true);
    renderList(now, false);
  }
  function syncTick() {
    var want = visible && items.length > 0;
    if (want && tickTimer === null) tickTimer = setInterval(tick, 1000);
    if (!want && tickTimer !== null) { clearInterval(tickTimer); tickTimer = null; }
  }

  // Pointer -------------------------------------------------------------------
  function setInteractive(next) {
    if (interactive === next) return;
    interactive = next;
    if (bridge) bridge.setInteractive(next);
  }
  function setExpanded(next) {
    if (expanded === next) return;
    expanded = next;
    setFlag(shell, "data-expanded", next);
    if (next) {
      // Clicks in the first moments after opening are the hover's, not a decision.
      armedAt = Date.now() + 350;
      renderList(Date.now(), true);
    } else {
      Object.keys(ui).forEach(function (key) { if (ui[key].confirm) delete ui[key]; });
    }
    applyGeometry();
  }
  function inside(x, y) {
    if (!visible) return false;
    var rect = shell.getBoundingClientRect();
    var slop = expanded ? 10 : 6;
    return x >= rect.left - slop && x <= rect.right + slop && y >= 0 && y <= rect.bottom + slop;
  }
  function leave(delay) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
    if (leaveTimer !== null) return;
    leaveTimer = setTimeout(function () {
      leaveTimer = null;
      setExpanded(false);
      setInteractive(false);
    }, delay);
  }
  document.addEventListener("mousemove", function (event) {
    if (inside(event.clientX, event.clientY)) {
      clearTimeout(leaveTimer);
      leaveTimer = null;
      setInteractive(true);
      if (!expanded && hoverTimer === null && prefs.expandOn === "hover" && !bare) {
        hoverTimer = setTimeout(function () { hoverTimer = null; setExpanded(true); }, 140);
      }
    } else if (interactive || hoverTimer !== null) {
      leave(expanded ? 260 : 0);
    }
  });
  document.addEventListener("mouseleave", function () { leave(expanded ? 260 : 0); });
  $("bar").addEventListener("click", function () {
    if (expanded) {
      if (prefs.expandOn === "click") setExpanded(false);
      return;
    }
    if (bare) return;
    var model = compactModel(Date.now());
    if (model && model.single && prefs.expandOn === "hover") openItem(model.single);
    else setExpanded(true);
  });
  var gear = $("gear");
  gear.innerHTML = GEAR;
  gear.addEventListener("click", function (event) {
    event.stopPropagation();
    if (bridge) bridge.act({ type: "settings" });
    setExpanded(false);
    setInteractive(false);
  });
  function openItem(item) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
    if (bridge) bridge.act({ type: "open", environmentId: item.environmentId, threadId: item.threadId });
    setExpanded(false);
    setInteractive(false);
  }

  // State ---------------------------------------------------------------------
  function show(next) {
    if (visible === next) return;
    visible = next;
    setFlag(shell, "data-hidden", !next);
    if (!next) {
      setExpanded(false);
      setInteractive(false);
      compactKey = "";
      lastPrimary = "";
    }
    syncTick();
  }

  function receive(state) {
    if (!state || typeof state !== "object") return;
    var snapshot = state.snapshot;
    if (state.geometry) geometry = state.geometry;
    lang = snapshot && snapshot.language === "zh" ? "zh" : "en";
    var live = snapshot && Array.isArray(snapshot.items) ? snapshot.items.slice() : [];
    if (snapshot && snapshot.prefs) prefs = snapshot.prefs;
    recent = snapshot && snapshot.recent ? snapshot.recent : null;
    // At rest the island shows the last thread to finish, or just its standby icon.
    resting = live.length === 0 && prefs.idleVisible && recent !== null;
    bare = live.length === 0 && prefs.idleVisible && recent === null;
    items = resting ? [Object.assign({}, recent, { status: "rest" })] : live;
    gear.title = t("settings");
    var now = Date.now();

    var doneKeys = {};
    live.forEach(function (item) {
      if (item.status !== "done") return;
      var key = keyOf(item);
      doneKeys[key] = true;
      if (seenDone && !seenDone[key] && prefs.motion) flash = { key: key, until: now + 4500 };
    });
    seenDone = doneKeys;
    clearTimeout(flashTimer);
    if (flash && flash.until > now) {
      flashTimer = setTimeout(function () { flash = null; renderCompact(Date.now(), true); }, flash.until - now + 20);
    }
    settleUi();

    setFlag(shell, "data-bare", bare);
    if (live.length === 0 && !prefs.idleVisible) {
      show(false);
      applyGeometry();
      return;
    }
    if (bare) {
      setExpanded(false);
      var stack = el("span", "stack");
      stack.appendChild(orb("idle", 0));
      cLead.replaceChild(stack, cLead.querySelector(".stack"));
      compactKey = "bare";
      lastPrimary = "";
      renderSummary();
      if (!visible) {
        applyGeometry();
        void shell.offsetWidth;
        show(true);
        requestAnimationFrame(function () { applyGeometry(); });
      } else {
        applyGeometry();
      }
      return;
    }
    if (!visible) {
      applyGeometry();
      renderCompact(now, false);
      void shell.offsetWidth;
      show(true);
      requestAnimationFrame(function () { applyGeometry(); });
    } else {
      renderCompact(now, true);
    }
    renderSummary();
    if (expanded) renderList(now, false);
  }

  // Text can settle after a measure, as when a font arrives late; follow the real sizes.
  if (window.ResizeObserver) {
    var resize = new ResizeObserver(function () { if (visible) applyGeometry(); });
    resize.observe(list);
    resize.observe(cLead);
    resize.observe(cTrail);
  }

  if (bridge) bridge.onState(receive);
})();
`;

const BODY = `
<div class="shell" id="shell" data-shape="pill" data-hidden>
  <i class="flare l"></i><i class="flare r"></i>
  <div class="island">
    <div class="bar" id="bar">
      <div class="face compact" id="compact">
        <div class="lead" id="c-lead"><span class="stack"></span><span class="title" id="c-title"></span><span class="ear-label" id="c-ear-label"></span></div>
        <div class="trail" id="c-trail">
          <span class="counters" id="c-counters"></span>
          <span class="chip" id="c-chip"><span id="c-label"></span><span class="chip-meta" id="c-meta"></span></span>
          <span class="ear-meta" id="c-ear-meta"></span>
        </div>
      </div>
      <div class="face header" id="header">
        <div class="lead"><span class="brand"><b>T3</b> Code</span></div>
        <div class="trail"><span class="summary" id="summary"></span><button class="gear" id="gear"></button></div>
      </div>
    </div>
    <div class="panel" id="panel"><div class="list" id="list"></div></div>
  </div>
</div>
`;

const ISLAND_PAGE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<meta name="color-scheme" content="dark">
<style>${STYLE}</style>
</head>
<body>${BODY}<script>${SCRIPT}</script></body>
</html>`;

export const buildIslandPageDataUrl = (): string =>
  `data:text/html;charset=utf-8,${encodeURIComponent(ISLAND_PAGE_HTML)}`;
