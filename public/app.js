// Agent Canvas client: Board (infinite), Diagram (interactive graph), and UI (non-infinite dockable workspace) modes.
import { MERMAID_THEME } from "./mermaid-theme.js";
import * as dock from "./dock.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const parseMode = (m) => (m === "diagram" ? "diagram" : m === "ui" ? "ui" : "board");
const modeIcon = (m) => (m === "diagram" ? "◈" : m === "ui" ? "⊞" : "▦");

async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

// ---- optional libs from CDN (UI still works without them) --------------------
let marked = null;
let mermaid = null;
const libsReady = Promise.all([
  import("https://cdn.jsdelivr.net/npm/marked@15.0.7/lib/marked.esm.js")
    .then((m) => {
      marked = m.marked;
      marked.use({ renderer: { html: (t) => esc(typeof t === "string" ? t : t.text) } });
    })
    .catch((e) => console.warn("marked unavailable", e)),
  import("https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs")
    .then((m) => {
      mermaid = m.default;
      mermaid.initialize({
        startOnLoad: false,
        theme: "base",
        securityLevel: "strict",
        fontFamily: MERMAID_THEME.fontFamily,
        themeVariables: MERMAID_THEME,
      });
    })
    .catch((e) => console.warn("mermaid unavailable", e)),
]);

const md = (text) => (marked ? marked.parse(text || "") : `<p>${esc(text || "").replace(/\n/g, "<br>")}</p>`);

const COLLAPSED_H = 98;
const DOCK_TAB_H = 36;
const DOCK_GAP = 8;

// ---- state -----------------------------------------------------------------
const viewport = $("#viewport");
const world = $("#world");
const edgesSvg = $("#edges");
const dockLayer = $("#dockLayer");
const dockDrop = $("#dockDrop");
const dockPreview = $("#dockPreview");
const dockGhost = $("#dockGhost");
const dockShelf = $("#dockShelf");

const state = {
  canvasId: null,
  canvas: null,
  canvases: [],
  mode: "board", // "board" | "diagram" | "ui"
  view: { x: 0, y: 0, k: 1 },
  els: new Map(), // nodeId -> { el, body, rev, node }
  selected: null,
  linking: false,
  linkFrom: null,
  flowId: null,
  flowStep: 0,
  trail: [], // [{ id, name, fromNodeId }] for drill-down breadcrumbs
  nav: [], // [{ id, name, trail, view }] canvas back/forward history
  navIndex: -1,
  z: 10,
  pan: null,
  drag: null,
  anim: null,
  flash: new Set(),
  downNode: null, // node id under the last pointerdown (pointer capture retargets dblclick)
  // UI mode (dockable workspace) state
  dockLayout: null,
  dockRects: { panes: new Map(), splitters: [] },
  dockMaximized: null,
  dockDrag: null,
  dockSplit: null,
  dockFlashPane: null,
};

// ---- subgraph hierarchy helpers ---------------------------------------------
function nodeMap() {
  return new Map((state.canvas?.nodes ?? []).map((n) => [n.id, n]));
}

function effectiveGeom(n) {
  if (n.type === "group" && n.collapsed) {
    return { x: n.x, y: n.y, w: Math.min(n.w, 360), h: COLLAPSED_H };
  }
  return { x: n.x, y: n.y, w: n.w, h: n.h };
}

function isHiddenByCollapse(nodeId, byId = nodeMap()) {
  let cur = byId.get(nodeId);
  const seen = new Set([nodeId]);
  while (cur?.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    const parent = byId.get(cur.parentId);
    if (!parent) break;
    if (parent.type === "group" && parent.collapsed) return true;
    cur = parent;
  }
  return false;
}

/** Walk up parentId to find the outermost collapsed ancestor (or nodeId if visible). */
function resolveEndpoint(nodeId, byId = nodeMap()) {
  let cur = byId.get(nodeId);
  if (!cur) return null;
  let resolved = nodeId;
  const seen = new Set([nodeId]);
  while (cur?.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    const parent = byId.get(cur.parentId);
    if (!parent) break;
    if (parent.type === "group" && parent.collapsed) resolved = parent.id;
    cur = parent;
  }
  return resolved;
}

function descendantsOf(groupId) {
  const nodes = state.canvas?.nodes ?? [];
  const out = [];
  const queue = [groupId];
  const seen = new Set([groupId]);
  while (queue.length) {
    const pid = queue.shift();
    for (const n of nodes) {
      if (n.parentId === pid && !seen.has(n.id)) {
        seen.add(n.id);
        out.push(n);
        if (n.type === "group") queue.push(n.id);
      }
    }
  }
  return out;
}

function visibleNodes() {
  const byId = nodeMap();
  return (state.canvas?.nodes ?? []).filter((n) => !isHiddenByCollapse(n.id, byId));
}

// ---- view transform & smooth camera -----------------------------------------
let saveViewTimer;
function applyView() {
  if (state.mode === "ui") {
    world.style.transform = "";
    viewport.style.backgroundPosition = "";
    viewport.style.backgroundSize = "";
    return;
  }
  const { x, y, k } = state.view;
  world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  viewport.style.backgroundPosition = `${x}px ${y}px`;
  viewport.style.backgroundSize = `${24 * k}px ${24 * k}px`;
  $("#zoomPct").textContent = `${Math.round(k * 100)}%`;
  clearTimeout(saveViewTimer);
  saveViewTimer = setTimeout(() => {
    try { localStorage.setItem(`view:${state.canvasId}`, JSON.stringify(state.view)); } catch {}
  }, 300);
}

function cancelAnim() {
  if (state.anim) { cancelAnimationFrame(state.anim); state.anim = null; }
}

function animateToView(target, ms = 280) {
  if (state.mode === "ui") return;
  cancelAnim();
  const start = { ...state.view };
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / ms);
    const e = 1 - Math.pow(1 - p, 3);
    state.view = {
      x: start.x + (target.x - start.x) * e,
      y: start.y + (target.y - start.y) * e,
      k: start.k + (target.k - start.k) * e,
    };
    applyView();
    if (p < 1) state.anim = requestAnimationFrame(step);
    else state.anim = null;
  };
  state.anim = requestAnimationFrame(step);
}

function zoomAt(cx, cy, factor) {
  if (state.mode === "ui") return;
  cancelAnim();
  const v = state.view;
  const k = Math.min(4, Math.max(0.05, v.k * factor));
  v.x = cx - (cx - v.x) * (k / v.k);
  v.y = cy - (cy - v.y) * (k / v.k);
  v.k = k;
  applyView();
}

function toWorld(clientX, clientY) {
  const { x, y, k } = state.view;
  return { x: (clientX - x) / k, y: (clientY - y) / k };
}

function visibleRect() {
  const rightInset = !$("#inspector").hidden ? 390 : 0;
  const topInset = (!$("#flowbar").hidden || !$("#breadcrumbs").hidden) ? 114 : 70;
  return {
    left: 48,
    top: topInset,
    width: Math.max(240, innerWidth - 96 - rightInset),
    height: Math.max(200, innerHeight - topInset - 56),
  };
}

function fit(nodes = visibleNodes(), animate = false) {
  if (state.mode === "ui") { renderDock(); return; }
  if (!nodes.length) { state.view = { x: 60, y: 90, k: 1 }; return applyView(); }
  const boxes = nodes.map(effectiveGeom);
  const minX = Math.min(...boxes.map((b) => b.x)), minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w)), maxY = Math.max(...boxes.map((b) => b.y + b.h));
  const box = visibleRect();
  const k = Math.min(1.08, box.width / Math.max(1, maxX - minX), box.height / Math.max(1, maxY - minY));
  const target = {
    k,
    x: box.left + (box.width - (maxX - minX) * k) / 2 - minX * k,
    y: box.top + (box.height - (maxY - minY) * k) / 2 - minY * k,
  };
  if (animate) animateToView(target);
  else { cancelAnim(); state.view = target; applyView(); }
}

function panToNode(id, { zoom } = {}) {
  if (state.mode === "ui") { focusDockNode(id); return; }
  const n = state.canvas?.nodes.find((x) => x.id === id);
  if (!n) return;
  const g = effectiveGeom(n);
  const box = visibleRect();
  const k = zoom ?? Math.max(0.75, Math.min(1.15, state.view.k));
  const cx = g.x + g.w / 2, cy = g.y + g.h / 2;
  animateToView({
    k,
    x: box.left + box.width / 2 - cx * k,
    y: box.top + box.height / 2 - cy * k,
  });
}

// ---- mode, breadcrumbs & graph highlight ------------------------------------
function syncModeChrome() {
  document.body.classList.toggle("mode-diagram", state.mode === "diagram");
  document.body.classList.toggle("mode-ui", state.mode === "ui");
  document.body.classList.toggle("mode-board", state.mode === "board");
  dockLayer.hidden = state.mode !== "ui";
  if (state.mode !== "ui") {
    dockShelf.hidden = true;
    dockDrop.hidden = true;
    state.dockMaximized = null;
    for (const rec of state.els.values()) rec.el.classList.remove("dock-hidden");
  } else {
    cancelAnim();
    setLinking(false);
  }
  document.querySelectorAll("[data-mode]").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === state.mode);
  });
  $("#hint").textContent = state.mode === "diagram"
    ? "Click a layered node to enter its subgraph · Alt+Click or ⓘ to inspect · Backspace to go up · L to link · F to fit"
    : "Drag background to pan · Ctrl/⌘ + scroll to zoom · Double-click to add a note · F to fit";
  applyView();
  renderBreadcrumbs();
  renderFlowBar();
  renderInspector();
  applyGraphHighlight();
}

async function setMode(mode, persist = true) {
  if (mode !== "board" && mode !== "diagram" && mode !== "ui") return;
  const prev = state.mode;
  state.mode = mode;
  if (mode !== "diagram") {
    state.flowId = null;
    state.flowStep = 0;
  }
  if (mode === "ui" && state.canvas) {
    state.dockLayout = dock.normalizeLayout(state.dockLayout ?? state.canvas.layout, state.canvas.nodes);
  }
  syncModeChrome();
  if (state.canvas) {
    render();
    if (prev === "ui" && mode !== "ui") {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(`view:${state.canvasId}`)); } catch {}
      if (saved) { state.view = saved; applyView(); }
      else fit();
    }
  }
  if (persist && state.canvasId) {
    try {
      await api("PATCH", `/api/canvases/${encodeURIComponent(state.canvasId)}`, { mode });
    } catch {}
  }
}

function setLinking(on) {
  state.linking = on;
  state.linkFrom = null;
  document.body.classList.toggle("linking", on);
  $("#linkMode").classList.toggle("active", on);
  for (const rec of state.els.values()) rec.el.classList.remove("link-source");
  if (on) toast("Link mode: click a source node, then a target node (or click an arrow to delete it).");
}

function buildTrail() {
  if (state.trail.length) return [...state.trail];
  // Reconstruct full ancestor chain from parentCanvasId if opened directly
  const out = [];
  const byId = new Map(state.canvases.map((c) => [c.id, c]));
  let pid = state.canvas?.parentCanvasId;
  const seen = new Set([state.canvasId]);
  while (pid && !seen.has(pid)) {
    seen.add(pid);
    const p = byId.get(pid);
    out.unshift({ id: pid, name: p?.name ?? pid });
    pid = p?.parentCanvasId;
  }
  return out;
}

function renderBreadcrumbs() {
  const el = $("#breadcrumbs");
  if (!state.canvas) { el.hidden = true; return; }
  const items = buildTrail();
  if (!items.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = items.map((item, idx) =>
    `<button class="crumb" data-crumb="${idx}">${idx === 0 ? "◈ " : ""}${esc(item.name)}</button><span class="crumb-sep">›</span>`
  ).join("") + `<span class="crumb-cur">${esc(state.canvas.name)}</span>`;
  el.querySelectorAll("[data-crumb]").forEach((b) => {
    b.onclick = () => {
      const idx = +b.dataset.crumb;
      const target = items[idx];
      loadCanvas(target.id, { focus: target.fromNodeId, keepTrail: true, entering: true, trail: items.slice(0, idx) });
    };
  });
}

function navigateUp() {
  const items = buildTrail();
  if (!items.length) return false;
  const parent = items[items.length - 1];
  loadCanvas(parent.id, { focus: parent.fromNodeId, keepTrail: true, entering: true, trail: items.slice(0, -1) });
  return true;
}

async function openSubCanvas(subCanvasId, fromNodeId) {
  if (!subCanvasId) return;
  const existing = buildTrail();
  const trail = [...existing, { id: state.canvasId, name: state.canvas?.name || state.canvasId, fromNodeId }];
  await loadCanvas(subCanvasId, { keepTrail: true, entering: true, trail });
}

// ---- lateral canvas links (persisted on the canvas; symmetric) ------------
function linkedIds() {
  if (!state.canvas) return [];
  return (Array.isArray(state.canvas.links) ? state.canvas.links : []).filter((id) => id !== state.canvasId);
}

async function toggleLink(b) {
  const a = state.canvasId;
  if (!a || !b || a === b) return false;
  const on = !linkedIds().includes(b);
  try {
    const res = await api(
      on ? "POST" : "DELETE",
      `/api/canvases/${encodeURIComponent(a)}/links${on ? "" : "/" + encodeURIComponent(b)}`,
      on ? { to: b } : undefined,
    );
    state.canvas.links = Array.isArray(res?.canvas?.links) ? res.canvas.links : [];
    const entry = state.canvases.find((c) => c.id === a);
    if (entry) entry.links = [...state.canvas.links];
    return on;
  } catch (e) {
    toast(`Could not update link: ${e.message}`);
    return !on;
  }
}

function renderRelated() {
  if (!state.canvasId) return;
  const items = linkedIds()
    .map((id) => state.canvases.find((c) => c.id === id))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
  const pills = $("#relatedPills");
  pills.innerHTML = items.map((c) =>
    `<button class="related-pill" data-open="${esc(c.id)}" title="${esc(c.name)}">` +
    `<span class="mode">${modeIcon(c.mode)}</span>` +
    `<span class="rname">${esc(c.name)}</span><span class="count">${c.nodes ?? 0}</span></button>`
  ).join("");
  pills.querySelectorAll("[data-open]").forEach((b) => {
    b.onclick = () => {
      if ($("#relatedDlg").open) $("#relatedDlg").close();
      loadCanvas(b.dataset.open);
    };
  });
  $("#relatedGroup").hidden = items.length === 0;
  updateDock();
}

function renderLinkDialog() {
  if (!state.canvasId) return;
  const q = $("#rdSearch").value.trim().toLowerCase();
  const linked = new Set(linkedIds());
  const list = state.canvases
    .filter((c) => c.id !== state.canvasId && (!q || c.name.toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const el = $("#rdList");
  el.innerHTML = list.length
    ? list.map((c) => {
        const on = linked.has(c.id);
        return `<button class="rd-row${on ? " on" : ""}" data-toggle="${esc(c.id)}">` +
          `<span class="tick">${on ? "✓" : ""}</span>` +
          `<span class="rd-name">${esc(c.name)}${c.parentCanvasId ? `<span class="sub">subgraph</span>` : ""}</span>` +
          `<span class="rd-meta">${modeIcon(c.mode)} ${c.nodes ?? 0}</span></button>`;
      }).join("")
    : `<div class="rd-empty">${q ? `No canvases match “${esc(q)}”.` : "No other canvases yet."}</div>`;
  el.querySelectorAll("[data-toggle]").forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      await toggleLink(b.dataset.toggle);
      renderLinkDialog();
      renderRelated();
    };
  });
  $("#rdCount").textContent = `${linked.size} linked`;
}

function openRelatedDialog() {
  if (!state.canvasId) return;
  $("#rdSearch").value = "";
  renderLinkDialog();
  $("#relatedDlg").showModal();
  $("#rdSearch").focus();
}

/** Promote links created by the browser-local prototype into the persisted store. */
async function migrateLocalLinks() {
  let map = null;
  try { map = JSON.parse(localStorage.getItem("canvas-links:v1")); } catch {}
  if (!map || typeof map !== "object") return;
  const pairs = new Set();
  for (const [a, arr] of Object.entries(map)) {
    if (!Array.isArray(arr)) continue;
    for (const b of arr) {
      if (typeof b !== "string" || !b || a === b) continue;
      pairs.add([a, b].sort().join("\u0000"));
    }
  }
  localStorage.removeItem("canvas-links:v1");
  if (!pairs.size) return;
  for (const pair of pairs) {
    const [a, b] = pair.split("\u0000");
    try { await api("POST", `/api/canvases/${encodeURIComponent(a)}/links`, { to: b }); } catch {}
  }
  await loadList();
  renderRelated();
  if ($("#relatedDlg").open) renderLinkDialog();
}

// ---- canvas back/forward history ------------------------------------------
function syncNavEntry() {
  const entry = state.nav[state.navIndex];
  if (!entry || !state.canvasId || entry.id !== state.canvasId) return;
  entry.name = state.canvas?.name || entry.name;
  entry.trail = state.trail.map((t) => ({ ...t }));
  entry.view = { ...state.view };
}

function pushNavEntry(entry) {
  if (state.navIndex < state.nav.length - 1) state.nav = state.nav.slice(0, state.navIndex + 1);
  state.nav.push(entry);
  if (state.nav.length > 50) state.nav.shift();
  state.navIndex = state.nav.length - 1;
  renderNav();
}

function updateDock() {
  const wasHidden = $("#navdock").hidden;
  $("#navdock").hidden = $("#historyGroup").hidden && $("#relatedGroup").hidden;
  if (state.mode === "ui" && wasHidden !== $("#navdock").hidden) renderDock();
}

function renderNav() {
  const back = $("#navBack");
  const fwd = $("#navFwd");
  if (!back || !fwd) return;
  back.disabled = state.navIndex <= 0;
  fwd.disabled = state.navIndex >= state.nav.length - 1;
  $("#historyGroup").hidden = state.nav.length <= 1;
  updateDock();
}

async function goNav(delta) {
  const next = state.navIndex + delta;
  if (next < 0 || next >= state.nav.length) return;
  if (!state.canvases.some((c) => c.id === state.nav[next].id)) {
    state.nav.splice(next, 1);
    if (next <= state.navIndex) state.navIndex = Math.max(0, state.navIndex - 1);
    renderNav();
    return goNav(delta);
  }
  syncNavEntry();
  const entry = state.nav[next];
  state.navIndex = next;
  state.trail = entry.trail.map((t) => ({ ...t }));
  await loadCanvas(entry.id, { keepTrail: true, entering: true, fromHistory: true, restoreView: entry.view });
}

async function createSubgraphForNode(nodeId) {
  const n = nodeMap().get(nodeId);
  if (!n) return;
  const sub = await api("POST", "/api/canvases", {
    name: n.title,
    mode: "diagram",
    parentCanvasId: state.canvasId,
  });
  await api("PATCH", `/api/nodes/${encodeURIComponent(nodeId)}`, { subCanvasId: sub.id });
  await openSubCanvas(sub.id, nodeId);
}

function activeFlow() {
  if (!state.flowId || !state.canvas?.flows?.length) return null;
  return state.canvas.flows.find((f) => f.id === state.flowId) ?? null;
}

function getHighlightSet() {
  const byId = nodeMap();
  const edges = state.canvas?.edges ?? [];
  const hotEdges = new Set();
  const hotNodes = new Set();

  if (state.mode !== "diagram") return { active: false, hotEdges, hotNodes };

  const flow = activeFlow();
  if (flow && flow.steps.length) {
    const step = flow.steps[state.flowStep] ?? flow.steps[0];
    const targetId = resolveEndpoint(step.nodeId, byId);
    if (targetId) hotNodes.add(targetId);
    if (step.edges?.length) {
      for (const eid of step.edges) {
        hotEdges.add(eid);
        const e = edges.find((x) => x.id === eid);
        if (e) {
          const a = resolveEndpoint(e.from, byId), b = resolveEndpoint(e.to, byId);
          if (a) hotNodes.add(a);
          if (b) hotNodes.add(b);
        }
      }
    } else if (state.flowStep > 0) {
      const prevId = resolveEndpoint(flow.steps[state.flowStep - 1].nodeId, byId);
      for (const e of edges) {
        const a = resolveEndpoint(e.from, byId), b = resolveEndpoint(e.to, byId);
        if ((a === prevId && b === targetId) || (b === prevId && a === targetId)) {
          hotEdges.add(e.id);
          if (a) hotNodes.add(a);
          if (b) hotNodes.add(b);
        }
      }
    } else {
      for (const e of edges) {
        const a = resolveEndpoint(e.from, byId), b = resolveEndpoint(e.to, byId);
        if (a === targetId || b === targetId) {
          hotEdges.add(e.id);
          if (a) hotNodes.add(a);
          if (b) hotNodes.add(b);
        }
      }
    }
    return { active: true, hotEdges, hotNodes };
  }

  if (state.selected) {
    const sel = byId.get(state.selected);
    const memberIds = new Set([state.selected]);
    if (sel?.type === "group") {
      for (const d of descendantsOf(sel.id)) memberIds.add(d.id);
    }
    for (const id of memberIds) hotNodes.add(id);
    // Keep containing parent group(s) undimmed when a child is selected
    let p = sel?.parentId;
    while (p && byId.has(p)) { hotNodes.add(p); p = byId.get(p).parentId; }

    for (const e of edges) {
      const a = resolveEndpoint(e.from, byId), b = resolveEndpoint(e.to, byId);
      if (!a || !b || a === b) continue;
      if (memberIds.has(e.from) || memberIds.has(e.to) || a === state.selected || b === state.selected) {
        hotEdges.add(e.id);
        hotNodes.add(a);
        hotNodes.add(b);
      }
    }
    return { active: true, hotEdges, hotNodes };
  }

  return { active: false, hotEdges, hotNodes };
}

function applyGraphHighlight() {
  const { active, hotEdges, hotNodes } = getHighlightSet();
  for (const [id, rec] of state.els) {
    const isSel = id === state.selected;
    const isHot = hotNodes.has(id);
    rec.el.classList.toggle("selected", isSel);
    rec.el.classList.toggle("neighbor", active && isHot && !isSel && rec.node.type !== "group");
    rec.el.classList.toggle("dim", active && !isHot);
    rec.el.classList.toggle("link-source", state.linkFrom === id);
  }
  drawEdges(active, hotEdges);
}

// ---- rendering ---------------------------------------------------------------
function createNodeEl(n) {
  const el = document.createElement("div");
  el.className = `node node-${n.type}${n.author === "user" ? " by-user" : ""}`;
  el.dataset.id = n.id;
  if (n.type === "group") {
    el.innerHTML = `
      <div class="head">
        <button class="group-toggle" data-act="collapse" title="Collapse / expand subgraph">▾</button>
        <span class="badge">subgraph</span>
        <span class="title"></span>
        <span class="group-drill"></span>
        <span class="group-count"></span>
        <div class="acts">
          <button data-act="edit" title="Edit subgraph">✎</button>
          <button data-act="del" title="Delete subgraph (keeps children)">✕</button>
        </div>
      </div>
      <div class="body"></div>
      <div class="resize"></div>`;
  } else {
    el.innerHTML = `
      <div class="head">
        <span class="badge">${esc(n.type === "card" ? (n.group || "node") : n.type)}</span>
        <span class="title"></span>
        <span class="nid" title="Item id (tell your agent)">${n.id}</span>
        <div class="acts">
          ${n.type === "card" ? `<button data-act="inspect" title="Inspect details without entering subgraph">ⓘ</button>` : ""}
          <button data-act="edit" title="Edit source / history">✎</button>
          <button data-act="open" title="Open in new tab">↗</button>
          <button data-act="del" title="Delete">✕</button>
        </div>
      </div>
      <div class="body"></div>
      <div class="resize"></div>`;
  }
  world.appendChild(el);
  return { el, body: el.querySelector(".body"), sig: null, node: n };
}

let mermaidSeq = 0;
async function renderMermaid(rec, n) {
  const sig = rec.sig;
  if (!mermaid) { rec.body.innerHTML = `<pre class="src">${esc(n.content)}</pre>`; return; }
  const id = `mmd-${++mermaidSeq}`;
  try {
    const { svg } = await mermaid.render(id, n.content);
    if (rec.sig !== sig) return;
    rec.body.innerHTML = svg;
    const s = rec.body.querySelector("svg");
    s?.removeAttribute("width");
    s?.removeAttribute("height");
  } catch (e) {
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
    if (rec.sig !== sig) return;
    rec.body.innerHTML = `<div><div class="err">Mermaid error: ${esc(e.message ?? e)}</div><pre class="src">${esc(n.content)}</pre></div>`;
  }
}

function degreeOf(nodeId) {
  const byId = nodeMap();
  const edges = state.canvas?.edges ?? [];
  let incoming = 0, outgoing = 0;
  for (const e of edges) {
    const a = resolveEndpoint(e.from, byId), b = resolveEndpoint(e.to, byId);
    if (!a || !b || a === b) continue;
    if (b === nodeId) incoming++;
    if (a === nodeId) outgoing++;
  }
  return { incoming, outgoing };
}

function renderCardBody(rec, n) {
  const { incoming, outgoing } = degreeOf(n.id);
  const accent = n.color || "#8a82cc";
  rec.el.style.setProperty("--card-accent", accent);
  rec.el.classList.toggle("has-subgraph", Boolean(n.subCanvasId));
  const badge = rec.el.querySelector(".head .badge");
  badge.textContent = n.group || "node";
  badge.style.color = accent;
  badge.style.background = `${accent}20`;
  const subInfo = n.subCanvasId ? state.canvases.find((c) => c.id === n.subCanvasId) : null;
  const subLabel = subInfo ? `◈ ${subInfo.nodes} ${subInfo.nodes === 1 ? "node" : "nodes"} ›` : "◈ Subgraph ›";
  rec.body.innerHTML = `
    <div class="card-sub">${esc(n.subtitle || n.content.split("\n")[0] || "")}</div>
    <div class="card-foot">
      <span>${esc(n.meta || n.id)}</span>
      <span class="card-deg">
        ${n.subCanvasId ? `<span class="subgraph-pill" title="Click node to enter subgraph">${subLabel}</span>` : ""}
        ${incoming ? `<span title="Incoming edges">← ${incoming}</span>` : ""}
        ${outgoing ? `<span title="Outgoing edges">→ ${outgoing}</span>` : ""}
      </span>
    </div>`;
}

function renderGroupBody(rec, n) {
  const accent = n.color || "#8a82cc";
  rec.el.style.setProperty("--group-accent", accent);
  rec.el.classList.toggle("collapsed", Boolean(n.collapsed));
  const toggle = rec.el.querySelector(".group-toggle");
  if (toggle) toggle.textContent = n.collapsed ? "▸" : "▾";
  const badge = rec.el.querySelector(".head .badge");
  badge.textContent = n.group || "subgraph";
  badge.style.color = accent;
  badge.style.background = `${accent}22`;
  const members = descendantsOf(n.id);
  const countEl = rec.el.querySelector(".group-count");
  if (countEl) countEl.textContent = `${members.length} ${members.length === 1 ? "node" : "nodes"}`;
  const drillSlot = rec.el.querySelector(".group-drill");
  if (drillSlot) {
    drillSlot.innerHTML = n.subCanvasId
      ? `<button class="drill-btn" data-drill="${esc(n.subCanvasId)}" title="Open deeper subgraph">⤵ Dive in</button>`
      : "";
  }
  const { incoming, outgoing } = degreeOf(n.id);
  if (n.collapsed) {
    rec.body.innerHTML = `
      <span class="group-sub">${esc(n.subtitle || `${members.length} collapsed items`)}</span>
      <span class="card-deg">
        ${incoming ? `<span>← ${incoming}</span>` : ""}
        ${outgoing ? `<span>→ ${outgoing}</span>` : ""}
      </span>`;
  } else {
    rec.body.innerHTML = n.subtitle ? `<span class="group-sub">${esc(n.subtitle)}</span>` : "";
  }
}

function fillBody(rec, n) {
  rec.body.innerHTML = "";
  if (n.type === "html") {
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts allow-forms allow-popups allow-modals");
    f.setAttribute("title", n.title);
    // The server composes the app page: node HTML + the canvas runtime it talks to.
    f.src = `/api/nodes/${encodeURIComponent(n.id)}/app?v=${n.rev}`;
    rec.body.appendChild(f);
  } else if (n.type === "diagram") {
    renderMermaid(rec, n);
  } else if (n.type === "card") {
    renderCardBody(rec, n);
  } else if (n.type === "group") {
    renderGroupBody(rec, n);
  } else {
    rec.body.innerHTML = md(n.content);
  }
}

function place(el, n) {
  const g = effectiveGeom(n);
  el.style.left = `${g.x}px`;
  el.style.top = `${g.y}px`;
  el.style.width = `${g.w}px`;
  el.style.height = `${g.h}px`;
}

function render() {
  const c = state.canvas;
  const byId = nodeMap();
  const seen = new Set();
  for (const n of c.nodes) {
    seen.add(n.id);
    let rec = state.els.get(n.id);
    if (!rec) { rec = createNodeEl(n); state.els.set(n.id, rec); }
    if (state.drag?.id === n.id) Object.assign(n, state.drag.geom);
    rec.node = n;
    const sig = `${n.type}\u0001${n.content}`;
    if (rec.sig !== sig) { rec.sig = sig; fillBody(rec, n); }
    else if (n.type === "card") { renderCardBody(rec, n); }
    else if (n.type === "group") { renderGroupBody(rec, n); }
    rec.el.querySelector(".title").textContent = n.title;
    if (state.mode !== "ui") {
      rec.el.classList.remove("dock-hidden");
      rec.el.hidden = isHiddenByCollapse(n.id, byId);
      place(rec.el, n);
      if (state.flash.has(n.id)) {
        state.flash.delete(n.id);
        rec.el.classList.remove("flash");
        void rec.el.offsetWidth;
        rec.el.classList.add("flash");
      }
    } else if (state.flash.has(n.id)) {
      state.flash.delete(n.id);
      const pane = dock.findPaneOfNode(state.dockLayout?.root, n.id);
      if (pane) state.dockFlashPane = pane.id;
    }
  }
  for (const [id, rec] of state.els) if (!seen.has(id)) { rec.el.remove(); state.els.delete(id); }
  if (state.selected && (!seen.has(state.selected) || (state.mode !== "ui" && isHiddenByCollapse(state.selected, byId)))) {
    state.selected = null;
  }
  renderBreadcrumbs();
  if (state.mode === "ui") {
    state.dockLayout = dock.normalizeLayout(state.dockLayout ?? c.layout, c.nodes);
    renderDock();
  } else {
    applyGraphHighlight();
    renderFlowBar();
    renderInspector();
  }
  $("#empty").hidden = c.nodes.length > 0;
}

function borderPoint(a, b, curveBias = 0) {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2, by = b.y + b.h / 2;
  let dx = bx - ax, dy = by - ay;
  if (!dx && !dy) return { x: ax, y: ay };
  if (curveBias) {
    const len = Math.hypot(dx, dy) || 1;
    dx += (-dy / len) * curveBias;
    dy += (dx / len) * curveBias;
  }
  const t = Math.min(dx ? a.w / 2 / Math.abs(dx) : Infinity, dy ? a.h / 2 / Math.abs(dy) : Infinity);
  return { x: ax + dx * t, y: ay + dy * t };
}

function drawEdges(highlightActive = false, hotEdges = new Set()) {
  if (!state.canvas) return;
  const byId = nodeMap();

  // Resolve visible endpoints (rerouting edges cleanly when a subgraph is collapsed)
  const resolved = [];
  const seenCollapsed = new Map(); // dedupe identical collapsed cross-edges
  for (const e of state.canvas.edges) {
    const fromId = resolveEndpoint(e.from, byId);
    const toId = resolveEndpoint(e.to, byId);
    if (!fromId || !toId || fromId === toId) continue;
    const isRerouted = fromId !== e.from || toId !== e.to;
    if (isRerouted) {
      const k = `${fromId}->${toId}`;
      const prev = seenCollapsed.get(k);
      if (prev) {
        if (e.label && !prev.labels.includes(e.label)) prev.labels.push(e.label);
        if (hotEdges.has(e.id)) prev.hot = true;
        continue;
      }
      const item = { id: e.id, fromId, toId, labels: e.label ? [e.label] : [], hot: hotEdges.has(e.id) };
      seenCollapsed.set(k, item);
      resolved.push(item);
    } else {
      resolved.push({ id: e.id, fromId, toId, labels: e.label ? [e.label] : [], hot: hotEdges.has(e.id) });
    }
  }

  const pairGroups = new Map();
  for (const r of resolved) {
    const key = r.fromId < r.toId ? `${r.fromId}|${r.toId}` : `${r.toId}|${r.fromId}`;
    if (!pairGroups.has(key)) pairGroups.set(key, []);
    pairGroups.get(key).push(r);
  }

  let s = `<defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path class="arrowhead" d="M0,0 L10,5 L0,10 z"/>
    </marker>
    <marker id="arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path class="arrowhead hot" d="M0,0 L10,5 L0,10 z"/>
    </marker>
  </defs>`;

  for (const r of resolved) {
    const a = effectiveGeom(byId.get(r.fromId));
    const b = effectiveGeom(byId.get(r.toId));
    const key = r.fromId < r.toId ? `${r.fromId}|${r.toId}` : `${r.toId}|${r.fromId}`;
    const siblings = pairGroups.get(key);
    const idx = siblings.indexOf(r);
    const dirSign = r.fromId < r.toId ? 1 : -1;
    const curve = siblings.length > 1 ? ((idx - (siblings.length - 1) / 2) * 56) * dirSign : 0;

    const p = borderPoint(a, b, curve * 0.35);
    const q = borderPoint(b, a, -curve * 0.35);
    const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
    const vx = q.x - p.x, vy = q.y - p.y;
    const len = Math.hypot(vx, vy) || 1;
    const nx = -vy / len, ny = vx / len;
    const cx = mx + nx * curve, cy = my + ny * curve;
    const lx = curve ? (p.x + 2 * cx + q.x) / 4 : mx;
    const ly = curve ? (p.y + 2 * cy + q.y) / 4 : my;

    const d = curve ? `M${p.x},${p.y} Q${cx},${cy} ${q.x},${q.y}` : `M${p.x},${p.y} L${q.x},${q.y}`;
    const isHot = highlightActive && r.hot;
    const isDim = highlightActive && !isHot;
    const cls = `edge${isHot ? " hot" : isDim ? " dim" : ""}`;
    const lcls = `elabel${isHot ? " hot" : isDim ? " dim" : ""}`;
    const label = r.labels.join(" · ");

    s += `<path class="edge-hit" data-edge="${esc(r.id)}" data-from="${esc(r.fromId)}" data-to="${esc(r.toId)}" d="${d}"><title>${esc(label || r.id)}</title></path>`;
    s += `<path class="${cls}" d="${d}" marker-end="url(#${isHot ? "arrow-hot" : "arrow"})"></path>`;
    if (label) s += `<text class="${lcls}" x="${lx}" y="${ly}">${esc(label)}</text>`;
  }
  edgesSvg.innerHTML = s;
}

// ---- Inspector Drawer & Flow Bar (Diagram mode) ------------------------------
function renderInspector() {
  const ins = $("#inspector");
  const byId = nodeMap();
  const n = state.selected && byId.get(state.selected);
  if (state.mode !== "diagram" || !n) {
    ins.hidden = true;
    return;
  }
  ins.hidden = false;
  const accent = n.color || "#8a82cc";
  const badge = $("#insBadge");
  badge.textContent = n.type === "card" ? (n.group || "node") : n.type === "group" ? (n.group || "subgraph") : n.type;
  badge.style.color = accent;
  badge.style.background = `${accent}22`;
  $("#insMeta").textContent = n.meta ? `${n.meta} · ${n.id}` : n.id;
  $("#insTitle").textContent = n.title;
  $("#insSub").textContent = n.subtitle || "";

  let linksHtml = "";

  // Quick subgraph actions (enter, create subgraph, collapse/expand, parent jump)
  const actions = [];
  if (n.subCanvasId) {
    actions.push(`<button class="ins-action-btn" data-drill="${esc(n.subCanvasId)}">◈ Enter Subgraph ›</button>`);
  } else if (n.type === "card" || n.type === "group") {
    actions.push(`<button class="ins-action-btn" data-create-sub="${esc(n.id)}">+ Create Subgraph</button>`);
  }
  if (n.type === "group") {
    actions.push(`<button class="ins-action-btn" data-toggle-collapse="${esc(n.id)}">${n.collapsed ? "▸ Expand Group" : "▾ Collapse Group"}</button>`);
  }
  if (n.parentId && byId.has(n.parentId)) {
    actions.push(`<button class="ins-chip" data-jump="${esc(n.parentId)}">↑ In ${esc(byId.get(n.parentId).title)}</button>`);
  }
  if (actions.length) linksHtml += `<div class="ins-actions" style="margin-bottom:12px">${actions.join("")}</div>`;

  // Contained nodes for group subgraphs
  if (n.type === "group") {
    const members = descendantsOf(n.id);
    linksHtml += `<h4>Contained Nodes (${members.length})</h4>`;
    linksHtml += members.length
      ? `<div class="ins-chips" style="margin-bottom:12px">${members.map((m) =>
          `<button class="ins-chip" data-jump="${esc(m.id)}">${esc(m.title)}${m.group ? `<span class="edge-tag">${esc(m.group)}</span>` : ""}</button>`
        ).join("")}</div>`
      : `<div style="color:var(--muted);font-size:12px;margin-bottom:12px">No member nodes assigned yet.</div>`;
  }

  // Incoming & outgoing connections (including cross-boundary for groups)
  const memberSet = new Set([n.id]);
  if (n.type === "group") for (const d of descendantsOf(n.id)) memberSet.add(d.id);

  const incoming = state.canvas.edges.filter((e) => memberSet.has(e.to) && !memberSet.has(e.from) && byId.has(e.from));
  const outgoing = state.canvas.edges.filter((e) => memberSet.has(e.from) && !memberSet.has(e.to) && byId.has(e.to));

  const chip = (targetId, dir, label) => {
    const t = byId.get(targetId);
    return `<button class="ins-chip" data-jump="${esc(targetId)}">
      <span>${dir} ${esc(t.title)}</span>
      ${label ? `<span class="edge-tag">${esc(label)}</span>` : ""}
    </button>`;
  };

  if (incoming.length || outgoing.length) {
    linksHtml += `
      ${incoming.length ? `<h4>Incoming (${incoming.length})</h4><div class="ins-chips" style="margin-bottom:10px">${incoming.map((e) => chip(e.from, "←", e.label)).join("")}</div>` : ""}
      ${outgoing.length ? `<h4>Outgoing (${outgoing.length})</h4><div class="ins-chips">${outgoing.map((e) => chip(e.to, "→", e.label)).join("")}</div>` : ""}
    `;
  } else if (n.type !== "group") {
    linksHtml += `<h4>Connections</h4><div style="color:var(--muted);font-size:12px">No arrows connected yet. Press <strong>L</strong> to link nodes.</div>`;
  }

  const linksEl = $("#insLinks");
  linksEl.innerHTML = linksHtml;
  linksEl.querySelectorAll("[data-jump]").forEach((b) => {
    b.onclick = () => jumpToNode(b.dataset.jump);
  });
  linksEl.querySelectorAll("[data-drill]").forEach((b) => {
    b.onclick = () => openSubCanvas(b.dataset.drill, n.id);
  });
  linksEl.querySelectorAll("[data-create-sub]").forEach((b) => {
    b.onclick = () => createSubgraphForNode(b.dataset.createSub);
  });
  linksEl.querySelectorAll("[data-toggle-collapse]").forEach((b) => {
    b.onclick = () => toggleCollapse(b.dataset.toggleCollapse);
  });

  const contentEl = $("#insContent");
  if (n.type === "html") {
    contentEl.innerHTML = `<h4>HTML Board</h4><p style="color:var(--muted)">Interactive HTML board rendered directly on the canvas. Click <strong>↗</strong> to open full-screen or <strong>✎</strong> to inspect source.</p>`;
  } else if (n.type === "diagram") {
    contentEl.innerHTML = `<h4>Mermaid Source</h4><pre><code>${esc(n.content)}</code></pre>`;
  } else {
    contentEl.innerHTML = n.content ? `<h4>Details</h4>${md(n.content)}` : "";
  }
}

async function toggleCollapse(groupId) {
  const n = nodeMap().get(groupId);
  if (!n || n.type !== "group") return;
  await api("PATCH", `/api/nodes/${encodeURIComponent(groupId)}`, { collapsed: !n.collapsed });
}

function renderFlowBar() {
  const bar = $("#flowbar");
  const flows = state.canvas?.flows ?? [];
  if (state.mode !== "diagram" || !flows.length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;

  const pills = $("#flowPills");
  pills.innerHTML = `<button class="flow-pill${!state.flowId ? " active" : ""}" data-flow="">Explore</button>` +
    flows.map((f) => `<button class="flow-pill${state.flowId === f.id ? " active" : ""}" data-flow="${esc(f.id)}">${esc(f.name)}</button>`).join("");

  pills.querySelectorAll("[data-flow]").forEach((b) => {
    b.onclick = () => startFlow(b.dataset.flow || null);
  });

  const flow = activeFlow();
  const nav = $("#flowNav");
  if (!flow) {
    $("#flowCaption").textContent = "Click any node to spotlight & inspect, or pick a flow.";
    nav.hidden = true;
  } else {
    const step = flow.steps[state.flowStep] ?? flow.steps[0];
    $("#flowCaption").textContent = step?.caption || "";
    nav.hidden = false;
    $("#flowCount").textContent = `${state.flowStep + 1}/${flow.steps.length}`;
    $("#flowPrev").disabled = state.flowStep <= 0;
    $("#flowNext").disabled = state.flowStep >= flow.steps.length - 1;
  }
}

async function ensureNodeVisible(nodeId) {
  const byId = nodeMap();
  let cur = byId.get(nodeId);
  while (cur?.parentId) {
    const parent = byId.get(cur.parentId);
    if (parent?.type === "group" && parent.collapsed) {
      await api("PATCH", `/api/nodes/${encodeURIComponent(parent.id)}`, { collapsed: false });
      parent.collapsed = false;
    }
    cur = parent;
  }
}

async function startFlow(flowId) {
  state.flowId = flowId;
  state.flowStep = 0;
  const flow = activeFlow();
  if (flow?.steps?.length) {
    const nid = flow.steps[0].nodeId;
    await ensureNodeVisible(nid);
    select(nid, { keepFlow: true });
    panToNode(nid);
  } else {
    renderFlowBar();
    applyGraphHighlight();
  }
}

async function stepFlow(delta) {
  const flow = activeFlow();
  if (!flow?.steps?.length) return;
  const next = Math.max(0, Math.min(flow.steps.length - 1, state.flowStep + delta));
  if (next === state.flowStep) return;
  state.flowStep = next;
  const nid = flow.steps[next].nodeId;
  await ensureNodeVisible(nid);
  select(nid, { keepFlow: true });
  panToNode(nid);
}

async function jumpToNode(id) {
  state.flowId = null;
  await ensureNodeVisible(id);
  select(id);
  panToNode(id);
  state.flash.add(id);
  render();
}

function select(id, { keepFlow = false } = {}) {
  if (!keepFlow) state.flowId = null;
  state.selected = id;
  const rec = id && state.els.get(id);
  if (rec && rec.node.type !== "group") rec.el.style.zIndex = ++state.z;
  applyGraphHighlight();
  renderFlowBar();
  renderInspector();
}

function focusNode(id) {
  const n = state.canvas?.nodes.find((x) => x.id === id);
  if (!n) return;
  if (state.mode === "ui") {
    focusDockNode(id);
    return;
  }
  select(id);
  if (state.mode === "diagram") panToNode(id);
  else fit([n], true);
  state.flash.add(id);
  render();
}

// ---- loading -------------------------------------------------------------------
function rootCanvasId(id, list = state.canvases) {
  const byId = new Map(list.map((c) => [c.id, c]));
  let cur = id;
  const seen = new Set([cur]);
  while (byId.get(cur)?.parentCanvasId && byId.has(byId.get(cur).parentCanvasId) && !seen.has(byId.get(cur).parentCanvasId)) {
    cur = byId.get(cur).parentCanvasId;
    seen.add(cur);
  }
  return cur;
}

async function loadList() {
  const list = await api("GET", "/api/canvases");
  state.canvases = list;
  const sel = $("#canvasSel");
  const ids = new Set(list.map((c) => c.id));
  const roots = list.filter((c) => !c.parentCanvasId || !ids.has(c.parentCanvasId));
  const activeRoot = rootCanvasId(state.canvasId, list);
  if (!roots.some((c) => c.id === activeRoot)) roots.unshift({ id: activeRoot, name: activeRoot, nodes: 0 });
  sel.innerHTML = roots.map((c) =>
    `<option value="${esc(c.id)}">${c.mode === "diagram" ? "◈ " : c.mode === "ui" ? "⊞ " : ""}${esc(c.name)} (${c.nodes})</option>`
  ).join("");
  sel.value = activeRoot;
  // Refresh subgraph node counts on visible cards
  if (state.canvas) {
    for (const rec of state.els.values()) {
      if (rec.node.type === "card" && rec.node.subCanvasId) renderCardBody(rec, rec.node);
    }
  }
  renderBreadcrumbs();
  renderRelated();
  renderNav();
}

async function loadCanvas(id, { focus, keepTrail = false, entering = false, fromHistory = false, restoreView = null, trail = null } = {}) {
  if (!fromHistory) syncNavEntry();
  if ($("#relatedDlg").open) $("#relatedDlg").close();
  for (const rec of state.els.values()) rec.el.remove();
  state.els.clear();
  state.selected = null;
  state.flowId = null;
  state.flowStep = 0;
  state.dockLayout = null;
  state.dockMaximized = null;
  state.dockDrag = null;
  state.dockSplit = null;
  state.dockFlashPane = null;
  if (trail) state.trail = trail.map((t) => ({ ...t }));
  else if (!keepTrail) state.trail = [];
  setLinking(false);
  state.canvasId = id;
  const url = new URL(location.href);
  url.searchParams.set("canvas", id);
  url.hash = "";
  history.replaceState(null, "", url);
  state.canvas = await api("GET", `/api/canvases/${encodeURIComponent(id)}`);
  state.mode = parseMode(state.canvas.mode);
  if (state.mode === "ui") {
    state.dockLayout = dock.normalizeLayout(state.canvas.layout, state.canvas.nodes);
  }
  syncModeChrome();
  render();
  if (entering && state.mode !== "ui") {
    world.classList.remove("entering");
    void world.offsetWidth;
    world.classList.add("entering");
  }
  if (state.mode === "ui") {
    if (focus) focusDockNode(focus);
  } else {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(`view:${id}`)); } catch {}
    if (restoreView) { state.view = { ...restoreView }; applyView(); }
    else if (focus) focusNode(focus);
    else if (saved && !entering) { state.view = saved; applyView(); }
    else fit();
  }
  if (!fromHistory) {
    pushNavEntry({
      id,
      name: state.canvas.name,
      trail: state.trail.map((t) => ({ ...t })),
      view: { ...state.view },
    });
  }
  loadList();
}

let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      state.canvas = await api("GET", `/api/canvases/${encodeURIComponent(state.canvasId)}`);
      const nextMode = parseMode(state.canvas.mode);
      if (nextMode !== state.mode) {
        state.mode = nextMode;
        syncModeChrome();
      }
      if (state.mode === "ui" && !state.dockDrag && !state.dockSplit) {
        state.dockLayout = dock.normalizeLayout(state.canvas.layout ?? state.dockLayout, state.canvas.nodes);
      }
      render();
      renderRelated();
      if ($("#relatedDlg").open) renderLinkDialog();
    } catch (e) { toast(`Refresh failed: ${e.message}`); }
  }, 40);
}

// ---- interactive app bridge (window.canvas inside HTML nodes) -------------------
function nodeIdForWindow(win) {
  for (const [id, rec] of state.els) {
    if (rec.el.querySelector("iframe")?.contentWindow === win) return id;
  }
  return null;
}

const resizeTimers = new Map();

window.addEventListener("message", async (e) => {
  const msg = e.data;
  if (!msg || msg.__canvas !== true || msg.kind !== "rpc") return;
  const nodeId = nodeIdForWindow(e.source);
  if (!nodeId) return; // not one of our apps
  const reply = (ok, value) => {
    try {
      e.source.postMessage({ __canvas: true, kind: "result", id: msg.id, ok, ...(ok ? { value } : { error: String(value?.message ?? value) }) }, "*");
    } catch {}
  };
  const rec = state.els.get(nodeId);
  if (!rec) return reply(false, "node is not on screen");
  const params = msg.params || {};
  try {
    switch (msg.method) {
      case "state.get":
        return reply(true, rec.node.state ?? null);
      case "state.set": {
        const saved = await api("PUT", `/api/nodes/${encodeURIComponent(nodeId)}/state`, { state: params.state ?? null });
        rec.node.state = saved.state;
        return reply(true, saved.state);
      }
      case "emit": {
        const ev = await api("POST", `/api/nodes/${encodeURIComponent(nodeId)}/events`, { type: params.type, payload: params.payload });
        return reply(true, ev);
      }
      case "notify":
        toast(String(params.text ?? ""));
        return reply(true, true);
      case "resize": {
        if (state.mode === "ui") return reply(true, true); // docked boards fill their pane
        const n = rec.node;
        // Apps ask for their own viewport size; the card also has a header and borders.
        const chromeH = Math.max(0, rec.el.offsetHeight - rec.body.clientHeight);
        const chromeW = Math.max(0, rec.el.offsetWidth - rec.body.clientWidth);
        const h = Math.round(Math.min(4000, Math.max(120, (Number(params.height) || n.h - chromeH) + chromeH)));
        const w = Math.round(Math.min(4000, Math.max(160, (Number(params.width) || n.w - chromeW) + chromeW)));
        if (h === n.h && (w === n.w || !params.width)) return reply(true, true);
        n.h = h;
        if (params.width) n.w = w;
        place(rec.el, n);
        const { active, hotEdges } = getHighlightSet();
        drawEdges(active, hotEdges);
        clearTimeout(resizeTimers.get(nodeId));
        resizeTimers.set(nodeId, setTimeout(() => {
          api("PATCH", `/api/nodes/${nodeId}`, { h: n.h, w: n.w }).catch(() => {});
        }, 200));
        return reply(true, true);
      }
      case "setTitle": {
        const title = String(params.title ?? "").trim();
        if (!title) return reply(false, "title required");
        await api("PATCH", `/api/nodes/${nodeId}`, { title });
        rec.node.title = title;
        rec.el.querySelector(".title").textContent = title;
        if (state.mode === "ui") renderDock();
        return reply(true, true);
      }
      case "open": {
        const id = String(params.id ?? "");
        if (!id) return reply(false, "id required");
        if (state.canvas?.nodes.some((n) => n.id === id)) {
          if (state.mode === "ui") focusDockNode(id);
          else { select(id); panToNode(id, { zoom: 1 }); }
        }
        else if (state.canvases.some((c) => c.id === id)) await loadCanvas(id);
        else return reply(false, `no node or canvas "${id}"`);
        return reply(true, true);
      }
      case "focus":
        if (params.nodeId) panToNode(String(params.nodeId));
        return reply(true, true);
      default:
        return reply(false, `unknown method ${msg.method}`);
    }
  } catch (err) {
    reply(false, err);
  }
});

// ---- toasts --------------------------------------------------------------------
function toast(text, action) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = text;
  if (action) {
    const b = document.createElement("button");
    b.textContent = action.label;
    b.onclick = () => { action.run(); t.remove(); };
    t.appendChild(b);
  }
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), 6000);
}

// ---- live updates --------------------------------------------------------------
let serverBootId = null;
function connectEvents() {
  const es = new EventSource("/api/events");
  const status = $("#status");
  let wasDown = false;
  es.onopen = () => {
    status.className = "status on";
    status.textContent = "● live";
    if (wasDown && state.canvasId) { scheduleRefresh(); loadList(); }
    wasDown = false;
  };
  es.onerror = () => { status.className = "status off"; status.textContent = "● offline"; wasDown = true; };
  es.onmessage = async (msg) => {
    const ev = JSON.parse(msg.data);
    if (ev.kind === "hello") {
      if (serverBootId && ev.bootId && ev.bootId !== serverBootId) return location.reload();
      serverBootId = ev.bootId;
      return;
    }
    if (ev.kind === "canvases") return loadList();
    if (ev.kind === "ui-state") {
      const rec = state.els.get(ev.nodeId);
      if (rec) {
        rec.node.state = ev.state;
        rec.el.querySelector("iframe")?.contentWindow?.postMessage({ __canvas: true, kind: "state:sync", state: ev.state }, "*");
      }
      return;
    }
    if (ev.kind === "ui-event") return;
    if (ev.kind === "focus") {
      if (ev.canvasId !== state.canvasId) await loadCanvas(ev.canvasId, { focus: ev.nodeId });
      else if (ev.nodeId) focusNode(ev.nodeId);
      else fit(undefined, true);
      return;
    }
    if (ev.kind !== "canvas") return;
    if (ev.canvasId === state.canvasId) {
      if (ev.nodeId && ev.action !== "deleted" && state.drag?.id !== ev.nodeId) state.flash.add(ev.nodeId);
      scheduleRefresh();
    } else if (ev.action === "created") {
      toast(`New “${ev.title}” on canvas ${ev.canvasId}`, {
        label: "Show",
        run: () => loadCanvas(ev.canvasId, { focus: ev.nodeId }),
      });
    }
  };
}

// ---- editor dialog -------------------------------------------------------------
const editor = $("#editor");
let editing = null;

async function openEditor(id) {
  const n = await api("GET", `/api/nodes/${id}`);
  editing = n;
  editor.dataset.type = n.type;
  $("#edType").textContent = n.type;
  $("#edTitle").value = n.title;
  $("#edContent").value = n.content;
  const hasMeta = n.type === "card" || n.type === "group";
  $("#edCardFields").hidden = !hasMeta;
  if (hasMeta) {
    $("#edSub").value = n.subtitle || "";
    $("#edGroup").value = n.group || "";
    $("#edMetaIn").value = n.meta || "";
    $("#edSubCanvas").value = n.subCanvasId || "";
    $("#edColor").value = n.color || "#8a82cc";
  }
  const versions = [{ label: `v${n.history.length + 1} · current`, title: n.title, content: n.content }]
    .concat(n.history.map((h, i) => ({ label: `v${i + 1} · ${new Date(h.at).toLocaleString()}`, ...h })).reverse());
  const vs = $("#edVersions");
  vs.innerHTML = versions.map((v, i) => `<option value="${i}">${esc(v.label)}</option>`).join("");
  vs.onchange = () => {
    const v = versions[+vs.value];
    $("#edTitle").value = v.title;
    $("#edContent").value = v.content;
    $("#edMeta").textContent = +vs.value ? "Viewing an old version — Save to restore it." : "";
  };
  vs.hidden = versions.length < 2;
  $("#edMeta").textContent = `by ${n.author} · id ${n.id}`;
  editor.showModal();
  $("#edContent").focus();
}

$("#edCancel").onclick = () => editor.close();
$("#edSave").onclick = async () => {
  if (!editing) return;
  try {
    const patch = { title: $("#edTitle").value, content: $("#edContent").value };
    if (editing.type === "card" || editing.type === "group") {
      patch.subtitle = $("#edSub").value;
      patch.group = $("#edGroup").value;
      patch.meta = $("#edMetaIn").value;
      patch.subCanvasId = $("#edSubCanvas").value;
      patch.color = $("#edColor").value;
    }
    await api("PATCH", `/api/nodes/${editing.id}`, patch);
    editor.close();
  } catch (e) { toast(`Save failed: ${e.message}`); }
};
$("#edContent").addEventListener("keydown", (e) => {
  if (e.key === "s" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $("#edSave").click(); }
  if (e.key === "Tab") {
    e.preventDefault();
    const t = e.target;
    t.setRangeText("  ", t.selectionStart, t.selectionEnd, "end");
  }
});

// ---- UI mode: non-infinite dockable workspace ---------------------------------
let persistDockTimer;
function persistDockLayout() {
  if (!state.canvasId || !state.dockLayout) return;
  const payload = dock.cloneLayout(state.dockLayout);
  if (state.canvas) state.canvas.layout = payload;
  clearTimeout(persistDockTimer);
  persistDockTimer = setTimeout(() => {
    api("PATCH", `/api/canvases/${encodeURIComponent(state.canvasId)}`, { layout: payload }).catch(() => {});
  }, 120);
}

function dockWorkspaceBox() {
  const top = $("#breadcrumbs").hidden ? 62 : 104;
  const hasBottomDock = !$("#navdock").hidden || !dockShelf.hidden;
  const bottom = hasBottomDock ? 58 : 12;
  return {
    x: 12,
    y: top,
    w: Math.max(240, innerWidth - 24),
    h: Math.max(180, innerHeight - top - bottom),
  };
}

function placeDockedNode(el, rect) {
  el.style.left = `${rect.x + 1}px`;
  el.style.top = `${rect.y + 1 + DOCK_TAB_H}px`;
  el.style.width = `${Math.max(1, rect.w - 2)}px`;
  el.style.height = `${Math.max(1, rect.h - 2 - DOCK_TAB_H)}px`;
}

function renderDockShelf(byId) {
  const minimized = (state.dockLayout?.minimized ?? []).filter((id) => byId.has(id));
  $("#dockRestoreAll").hidden = !minimized.length;
  if (!minimized.length) {
    dockShelf.hidden = true;
    $("#dockShelfPills").innerHTML = "";
    return;
  }
  dockShelf.hidden = false;
  $("#dockShelfPills").innerHTML = minimized.map((id) => {
    const n = byId.get(id);
    return `<button class="dock-shelf-pill" data-shelf-node="${esc(id)}" title="Click to restore or drag onto workspace to dock">` +
      `<span class="dot dot-${esc(n.type)}"></span>` +
      `<span class="pname">${esc(n.title)}</span></button>`;
  }).join("");
}

function positionDockElementsInPlace() {
  const box = dockWorkspaceBox();
  const rects = dock.computeRects(state.dockLayout?.root, box, DOCK_GAP);
  state.dockRects = rects;

  for (const [paneId, r] of rects.panes) {
    const paneEl = dockLayer.querySelector(`.dock-pane[data-pane-id="${paneId}"]`);
    if (paneEl) {
      paneEl.style.left = `${r.x}px`;
      paneEl.style.top = `${r.y}px`;
      paneEl.style.width = `${r.w}px`;
      paneEl.style.height = `${r.h}px`;
    }
    const rec = state.els.get(r.pane.active);
    if (rec) placeDockedNode(rec.el, r);
  }

  for (const s of rects.splitters) {
    const key = `${s.path.join(",")}:${s.index}`;
    const spEl = dockLayer.querySelector(`.dock-splitter[data-split-key="${key}"]`);
    if (spEl) {
      spEl.style.left = `${s.x}px`;
      spEl.style.top = `${s.y}px`;
      spEl.style.width = `${s.w}px`;
      spEl.style.height = `${s.h}px`;
      spEl.dataset.splitSpan = String(s.parentSpan);
    }
  }
}

function renderDock() {
  if (state.mode !== "ui" || !state.canvas) return;
  const byId = nodeMap();
  state.dockLayout = dock.normalizeLayout(state.dockLayout ?? state.canvas.layout, state.canvas.nodes);

  // Render shelf first so workspace height accounts for it accurately
  renderDockShelf(byId);

  if (state.dockMaximized && !dock.findPaneById(state.dockLayout.root, state.dockMaximized)) {
    state.dockMaximized = null;
  }

  const box = dockWorkspaceBox();
  let rects;
  if (state.dockMaximized) {
    const pane = dock.findPaneById(state.dockLayout.root, state.dockMaximized);
    rects = {
      panes: new Map([[pane.id, { pane, x: box.x, y: box.y, w: box.w, h: box.h }]]),
      splitters: [],
    };
  } else {
    rects = dock.computeRects(state.dockLayout.root, box, DOCK_GAP);
  }
  state.dockRects = rects;

  const activeByNode = new Map();
  let html = "";

  if (!rects.panes.size && (state.dockLayout.minimized?.length ?? 0) > 0) {
    html = `<div style="position:absolute;left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;display:grid;place-content:center;text-align:center;gap:10px;border:1px dashed var(--border-2);border-radius:12px;color:var(--muted)">
      <div>All boards are minimized to the dock shelf below.</div>
      <div><button class="primary" data-dock-restore-all>Restore all boards</button></div>
    </div>`;
  } else {
    for (const [paneId, r] of rects.panes) {
      const pane = r.pane;
      const single = pane.tabs.length === 1;
      const isMax = state.dockMaximized === paneId;
      const isFocused = pane.active === state.selected;
      const isFlash = state.dockFlashPane === paneId;
      activeByNode.set(pane.active, r);

      const tabsHtml = pane.tabs.map((nid) => {
        const n = byId.get(nid);
        if (!n) return "";
        const isActive = nid === pane.active;
        const badge = single ? `<span class="tbadge">${esc(n.type === "html" ? "app" : n.type)}</span>` : "";
        return `<button class="dock-tab${isActive ? " active" : ""}" data-tab-node="${esc(nid)}" data-pane-id="${esc(paneId)}" title="${esc(n.title)} (drag to dock)">` +
          `<span class="dot dot-${esc(n.type)}"></span>` +
          `<span class="tname">${esc(n.title)}</span>${badge}</button>`;
      }).join("");

      html += `<div class="dock-pane${single ? " single-tab" : ""}${isMax ? " maximized" : ""}${isFocused ? " focused" : ""}${isFlash ? " flash" : ""}" ` +
        `data-pane-id="${esc(paneId)}" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px">` +
        `<div class="dock-pane-head" data-pane-head="${esc(paneId)}">` +
          `<div class="dock-tabs">${tabsHtml}</div>` +
          `<div class="dock-pane-acts">` +
            `<button data-dock-act="edit" data-node="${esc(pane.active)}" title="Edit source / versions">✎</button>` +
            `<button data-dock-act="open" data-node="${esc(pane.active)}" title="Open in new tab">↗</button>` +
            `<button data-dock-act="minimize" data-node="${esc(pane.active)}" data-pane="${esc(paneId)}" title="Minimize to dock shelf">–</button>` +
            `<button data-dock-act="maximize" data-pane="${esc(paneId)}" title="${isMax ? "Restore layout (Esc)" : "Maximize pane"}">${isMax ? "⤡" : "⤢"}</button>` +
            `<button data-dock-act="del" data-node="${esc(pane.active)}" title="Delete board">✕</button>` +
          `</div>` +
        `</div>` +
      `</div>`;
    }

    for (const s of rects.splitters) {
      const pathStr = s.path.join(",");
      const key = `${pathStr}:${s.index}`;
      html += `<div class="dock-splitter ${s.dir}" data-split-key="${esc(key)}" data-split-path="${esc(pathStr)}" ` +
        `data-split-idx="${s.index}" data-split-dir="${s.dir}" data-split-span="${s.parentSpan}" ` +
        `title="Drag to resize · Double-click to equalize" ` +
        `style="left:${s.x}px;top:${s.y}px;width:${s.w}px;height:${s.h}px"></div>`;
    }
  }

  state.dockFlashPane = null;
  dockLayer.innerHTML = html;

  // Sync each node's visibility & docked rect without moving DOM nodes (preserves live iframes!)
  for (const [id, rec] of state.els) {
    const r = activeByNode.get(id);
    if (r) {
      rec.el.hidden = false;
      rec.el.classList.remove("dock-hidden");
      placeDockedNode(rec.el, r);
    } else {
      rec.el.classList.add("dock-hidden");
    }
  }
}

function focusDockNode(id) {
  if (!state.canvas || !nodeMap().has(id)) return;
  let changed = false;
  if ((state.dockLayout?.minimized ?? []).includes(id)) {
    state.dockLayout = dock.restoreNode(state.dockLayout, id);
    changed = true;
  }
  const pane = dock.findPaneOfNode(state.dockLayout?.root, id);
  if (pane) {
    if (pane.active !== id) {
      state.dockLayout = dock.activateTab(state.dockLayout, pane.id, id);
      changed = true;
    }
    if (state.dockMaximized && state.dockMaximized !== pane.id) {
      state.dockMaximized = null;
    }
    state.dockFlashPane = pane.id;
  }
  state.selected = id;
  renderDock();
  if (changed) persistDockLayout();
}

function computeTabInsertIndex(paneId, clientX) {
  const paneEl = dockLayer.querySelector(`.dock-pane[data-pane-id="${paneId}"]`);
  if (!paneEl) return null;
  const tabEls = [...paneEl.querySelectorAll(".dock-tab")];
  for (let i = 0; i < tabEls.length; i++) {
    const r = tabEls[i].getBoundingClientRect();
    if (clientX < r.left + r.width / 2) return i;
  }
  return tabEls.length;
}

function updateDockDragVisuals(clientX, clientY) {
  const d = state.dockDrag;
  if (!d) return;
  dockDrop.hidden = false;
  dockGhost.style.left = `${clientX}px`;
  dockGhost.style.top = `${clientY}px`;
  dockGhost.innerHTML = `<span class="dot dot-${esc(d.type)}" style="width:7px;height:7px;border-radius:50%;display:inline-block"></span>${esc(d.title)}`;

  const box = dockWorkspaceBox();
  const target = dock.hitTestDockTarget(clientX, clientY, state.dockRects, box, d, DOCK_TAB_H);
  if (target && target.overTabBar) {
    target.insertIndex = computeTabInsertIndex(target.paneId, clientX);
  }
  d.target = target;

  if (target && target.preview) {
    dockPreview.hidden = false;
    dockPreview.style.left = `${target.preview.x}px`;
    dockPreview.style.top = `${target.preview.y}px`;
    dockPreview.style.width = `${target.preview.w}px`;
    dockPreview.style.height = `${target.preview.h}px`;
    dockPreview.innerHTML = `<span class="dock-preview-label">${esc(target.label)}</span>`;
  } else {
    dockPreview.hidden = true;
  }
}

function startDockDrag(e, { nodeId, sourcePaneId, sourceTabCount, fromShelf }) {
  const n = nodeMap().get(nodeId);
  if (!n) return;
  state.dockDrag = {
    nodeId,
    sourcePaneId,
    sourceTabCount,
    fromShelf,
    title: n.title,
    type: n.type,
    sx: e.clientX,
    sy: e.clientY,
    moved: false,
    target: null,
  };
}

dockLayer.addEventListener("pointerdown", (e) => {
  if (state.mode !== "ui" || e.button !== 0) return;

  const splitter = e.target.closest(".dock-splitter");
  if (splitter) {
    e.preventDefault();
    const path = splitter.dataset.splitPath ? splitter.dataset.splitPath.split(",").map(Number) : [];
    const index = Number(splitter.dataset.splitIdx);
    const dir = splitter.dataset.splitDir;
    const parentSpan = Number(splitter.dataset.splitSpan) || 1;
    const split = dock.findSplitByPath(state.dockLayout?.root, path);
    if (!split) return;
    state.dockSplit = {
      path,
      index,
      dir,
      parentSpan,
      startPos: dir === "row" ? e.clientX : e.clientY,
      sizeA: split.sizes[index],
      sizeB: split.sizes[index + 1],
      moved: false,
      el: splitter,
    };
    splitter.classList.add("active");
    document.body.classList.add("busy");
    return;
  }

  if (e.target.closest("button[data-dock-act], button[data-dock-restore-all]")) return;

  const tab = e.target.closest(".dock-tab");
  if (tab) {
    const paneId = tab.dataset.paneId;
    const nodeId = tab.dataset.tabNode;
    const pane = dock.findPaneById(state.dockLayout?.root, paneId);
    if (!pane) return;
    startDockDrag(e, {
      nodeId,
      sourcePaneId: paneId,
      sourceTabCount: pane.tabs.length,
      fromShelf: false,
    });
    return;
  }

  // Dragging empty area of pane header drags the active board of that pane
  const head = e.target.closest("[data-pane-head]");
  if (head) {
    const paneId = head.dataset.paneHead;
    const pane = dock.findPaneById(state.dockLayout?.root, paneId);
    if (!pane) return;
    startDockDrag(e, {
      nodeId: pane.active,
      sourcePaneId: paneId,
      sourceTabCount: pane.tabs.length,
      fromShelf: false,
    });
  }
});

dockShelf.addEventListener("pointerdown", (e) => {
  if (state.mode !== "ui" || e.button !== 0) return;
  const pill = e.target.closest("[data-shelf-node]");
  if (!pill) return;
  startDockDrag(e, {
    nodeId: pill.dataset.shelfNode,
    sourcePaneId: null,
    sourceTabCount: 0,
    fromShelf: true,
  });
});

dockLayer.addEventListener("click", async (e) => {
  if (state.mode !== "ui") return;
  if (e.target.closest("[data-dock-restore-all]")) {
    state.dockLayout = dock.restoreAll(state.dockLayout);
    renderDock();
    persistDockLayout();
    return;
  }
  const btn = e.target.closest("button[data-dock-act]");
  if (!btn) return;
  const act = btn.dataset.dockAct;
  const nodeId = btn.dataset.node;
  const paneId = btn.dataset.pane;
  const n = nodeId ? nodeMap().get(nodeId) : null;
  if (act === "edit" && nodeId) openEditor(nodeId);
  else if (act === "open" && nodeId) open(`/api/nodes/${nodeId}/${n?.type === "html" ? "app" : "render"}`, "_blank");
  else if (act === "minimize" && nodeId) {
    if (state.dockMaximized === paneId) state.dockMaximized = null;
    state.dockLayout = dock.minimizeNode(state.dockLayout, nodeId);
    renderDock();
    persistDockLayout();
  } else if (act === "maximize" && paneId) {
    state.dockMaximized = state.dockMaximized === paneId ? null : paneId;
    renderDock();
  } else if (act === "del" && nodeId && confirm(`Delete “${n?.title}”?`)) {
    if (state.dockMaximized === paneId) state.dockMaximized = null;
    await api("DELETE", `/api/nodes/${nodeId}`);
  }
});

dockLayer.addEventListener("dblclick", (e) => {
  if (state.mode !== "ui") return;
  const splitter = e.target.closest(".dock-splitter");
  if (splitter) {
    const path = splitter.dataset.splitPath ? splitter.dataset.splitPath.split(",").map(Number) : [];
    const index = Number(splitter.dataset.splitIdx);
    state.dockLayout = dock.equalizeSplitAt(state.dockLayout, path, index);
    renderDock();
    persistDockLayout();
    return;
  }
  const head = e.target.closest("[data-pane-head]");
  if (head && !e.target.closest("button[data-dock-act]")) {
    const paneId = head.dataset.paneHead;
    state.dockMaximized = state.dockMaximized === paneId ? null : paneId;
    renderDock();
  }
});

window.addEventListener("pointermove", (e) => {
  if (state.dockSplit) {
    const sp = state.dockSplit;
    const cur = sp.dir === "row" ? e.clientX : e.clientY;
    const deltaPx = cur - sp.startPos;
    if (Math.abs(deltaPx) > 1) sp.moved = true;
    const split = dock.findSplitByPath(state.dockLayout?.root, sp.path);
    if (!split) return;
    const sum = split.sizes.reduce((a, b) => a + b, 0) || 100;
    const deltaPct = (deltaPx / Math.max(1, sp.parentSpan)) * sum;
    if (dock.resizeSplitAt(state.dockLayout, sp.path, sp.index, sp.sizeA + deltaPct, sp.sizeB - deltaPct)) {
      positionDockElementsInPlace();
    }
    return;
  }

  if (state.dockDrag) {
    const d = state.dockDrag;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 5) {
      d.moved = true;
      document.body.classList.add("busy");
      if (state.dockMaximized) {
        state.dockMaximized = null;
        renderDock();
      }
      const tabEl = dockLayer.querySelector(`.dock-tab[data-tab-node="${d.nodeId}"]`);
      if (tabEl) tabEl.classList.add("dragging");
    }
    if (d.moved) updateDockDragVisuals(e.clientX, e.clientY);
  }
});

function endDockPointer() {
  if (state.dockSplit) {
    const sp = state.dockSplit;
    state.dockSplit = null;
    sp.el?.classList.remove("active");
    document.body.classList.remove("busy");
    renderDock();
    if (sp.moved) persistDockLayout();
    return;
  }

  if (state.dockDrag) {
    const d = state.dockDrag;
    state.dockDrag = null;
    document.body.classList.remove("busy");
    dockDrop.hidden = true;
    dockPreview.hidden = true;

    if (d.moved) {
      if (d.target) {
        if (d.target.kind === "edge") {
          state.dockLayout = dock.dockToEdge(state.dockLayout, d.nodeId, d.target.edge);
        } else if (d.target.kind === "pane") {
          state.dockLayout = dock.dockTab(
            state.dockLayout,
            d.nodeId,
            d.target.paneId,
            d.target.zone,
            d.target.insertIndex,
          );
        }
        state.selected = d.nodeId;
        renderDock();
        persistDockLayout();
      } else {
        renderDock(); // clears .dragging class
      }
    } else if (d.fromShelf) {
      state.dockLayout = dock.restoreNode(state.dockLayout, d.nodeId);
      state.selected = d.nodeId;
      renderDock();
      persistDockLayout();
    } else if (d.sourcePaneId) {
      const pane = dock.findPaneById(state.dockLayout?.root, d.sourcePaneId);
      const changed = pane && pane.active !== d.nodeId;
      state.dockLayout = dock.activateTab(state.dockLayout, d.sourcePaneId, d.nodeId);
      state.selected = d.nodeId;
      renderDock();
      if (changed) persistDockLayout();
    }
  }
}

window.addEventListener("pointerup", endDockPointer);
window.addEventListener("pointercancel", endDockPointer);
window.addEventListener("resize", () => {
  if (state.mode === "ui") renderDock();
});

// ---- user-created items ----------------------------------------------------------
const TEMPLATES = {
  note: { title: "Note", content: "" },
  card: { title: "Module", subtitle: "Short role summary", group: "Service", color: "#7ab4e8", meta: "", content: "### Responsibilities\n\n- Describe what this node does\n" },
  group: { title: "Subgraph", subtitle: "Logical subsystem", group: "Subgraph", color: "#8a82cc", content: "" },
  html: {
    title: "Mockup",
    content: `<!doctype html>\n<html>\n<head>\n  <script src="https://cdn.tailwindcss.com"></script>\n</head>\n<body class="p-8 font-sans">\n  <h1 class="text-2xl font-bold">Hello</h1>\n</body>\n</html>\n`,
  },
  ui: {
    type: "html",
    title: "Interactive App",
    content: `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<meta name="color-scheme" content="dark" />\n<style>\n  * { box-sizing: border-box; }\n  body { margin: 0; padding: 18px; background: #0e0e0f; color: #c2c0b6; font: 13px/1.5 "JetBrains Mono", ui-monospace, monospace; }\n  h1 { margin: 0 0 8px; font-size: 14px; color: #d8d6cc; }\n  button { background: #4e46a0; color: #f0eefb; border: 0; border-radius: 6px; padding: 7px 12px; font: inherit; cursor: pointer; }\n  button:hover { background: #5e56b0; }\n</style>\n</head>\n<body>\n  <h1>Interactive Board</h1>\n  <p id="out">Count: 0</p>\n  <button id="inc">Increment &amp; Emit</button>\n  <script>\n    let count = (canvas.state.current()?.count) || 0;\n    const out = document.getElementById("out");\n    const draw = () => { out.textContent = "Count: " + count; };\n    draw();\n    document.getElementById("inc").onclick = async () => {\n      count++;\n      draw();\n      await canvas.state.set({ count });\n      canvas.emit("increment", { count });\n    };\n    canvas.on("state", (s) => { if (s && typeof s.count === "number") { count = s.count; draw(); } });\n  </script>\n</body>\n</html>\n`,
  },
  diagram: { title: "Diagram", content: "flowchart LR\n  A[Client] --> B[API]\n  B --> C[(Database)]\n" },
};

async function addItem(kind, at) {
  const tpl = TEMPLATES[kind];
  const nodeType = tpl.type || kind;
  const p = state.mode === "ui" ? { x: 0, y: 0 } : (at ?? toWorld(innerWidth / 2 - 150, innerHeight / 2 - 100));
  const n = await api("POST", `/api/canvases/${encodeURIComponent(state.canvasId)}/nodes`, {
    ...tpl, type: nodeType, x: p.x, y: p.y, author: "user",
  });
  if (state.mode === "ui") state.selected = n.id;
  openEditor(n.id);
}

// ---- pointer interaction ---------------------------------------------------------
viewport.addEventListener("pointerdown", async (e) => {
  if (state.mode === "ui") return;
  cancelAnim();
  const drillBtn = e.target.closest("[data-drill]");
  if (drillBtn) return; // handled in click

  const edgeHit = e.target.closest(".edge-hit");
  if (edgeHit) {
    const eid = edgeHit.dataset.edge;
    const edge = state.canvas?.edges.find((x) => x.id === eid);
    if (!edge) return;
    if (state.linking) {
      if (confirm(`Remove arrow ${edge.label ? `“${edge.label}”` : edge.id}?`)) {
        await api("DELETE", `/api/edges/${encodeURIComponent(eid)}`);
      }
      return;
    }
    if (state.mode === "diagram") {
      const fromId = edgeHit.dataset.from, toId = edgeHit.dataset.to;
      jumpToNode(state.selected === toId ? fromId : toId);
      return;
    }
  }

  const nodeEl = e.target.closest(".node");
  state.downNode = nodeEl ? nodeEl.dataset.id : null;
  if (nodeEl) {
    const id = nodeEl.dataset.id;
    if (state.linking && e.button === 0 && !e.target.closest("button")) {
      if (!state.linkFrom) {
        state.linkFrom = id;
        applyGraphHighlight();
      } else if (state.linkFrom === id) {
        state.linkFrom = null;
        applyGraphHighlight();
      } else {
        const label = prompt("Arrow label (optional):", "") ?? "";
        await api("POST", `/api/canvases/_/edges`, { from: state.linkFrom, to: id, label: label.trim() || undefined });
        state.linkFrom = null;
        applyGraphHighlight();
      }
      return;
    }

    const n = state.els.get(id).node;
    const isSubgraphClick = state.mode === "diagram" && Boolean(n.subCanvasId) && !e.altKey && e.button === 0 && !e.target.closest("button, .nid, .resize");
    if (!isSubgraphClick) select(id);
    if (e.button !== 0 || e.target.closest("button, .nid")) return;
    const mode = e.target.classList.contains("resize")
      ? "resize"
      : (e.target.closest(".head") || n.type === "card" || (n.type === "group" && n.collapsed))
        ? "move"
        : null;
    if (!mode) return;
    const childStarts = mode === "move" && n.type === "group"
      ? descendantsOf(id).map((c) => ({ id: c.id, x: c.x, y: c.y }))
      : [];
    state.drag = {
      id, mode, sx: e.clientX, sy: e.clientY,
      start: { x: n.x, y: n.y, w: n.w, h: n.h },
      geom: { x: n.x, y: n.y, w: n.w, h: n.h },
      childStarts,
      enterSubgraph: isSubgraphClick ? n.subCanvasId : null,
      moved: false,
    };
  } else {
    if (state.linking) { state.linkFrom = null; applyGraphHighlight(); }
    select(null);
    state.pan = { sx: e.clientX, sy: e.clientY, vx: state.view.x, vy: state.view.y };
    viewport.classList.add("panning");
  }
  viewport.setPointerCapture(e.pointerId);
  document.body.classList.add("busy");
});

viewport.addEventListener("pointermove", (e) => {
  if (state.pan) {
    state.view.x = state.pan.vx + e.clientX - state.pan.sx;
    state.view.y = state.pan.vy + e.clientY - state.pan.sy;
    applyView();
  } else if (state.drag) {
    const d = state.drag, k = state.view.k;
    const dx = (e.clientX - d.sx) / k, dy = (e.clientY - d.sy) / k;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (!d.moved) return;
    if (d.mode === "move") {
      d.geom.x = Math.round(d.start.x + dx);
      d.geom.y = Math.round(d.start.y + dy);
      const rdx = d.geom.x - d.start.x, rdy = d.geom.y - d.start.y;
      for (const ch of d.childStarts) {
        const crec = state.els.get(ch.id);
        if (!crec) continue;
        crec.node.x = ch.x + rdx;
        crec.node.y = ch.y + rdy;
        place(crec.el, crec.node);
      }
    } else {
      d.geom.w = Math.round(Math.max(160, d.start.w + dx));
      d.geom.h = Math.round(Math.max(88, d.start.h + dy));
    }
    const rec = state.els.get(d.id);
    Object.assign(rec.node, d.geom);
    place(rec.el, rec.node);
    const { active, hotEdges } = getHighlightSet();
    drawEdges(active, hotEdges);
  }
});

async function endPointer() {
  document.body.classList.remove("busy");
  viewport.classList.remove("panning");
  state.pan = null;
  const d = state.drag;
  state.drag = null;
  if (d && !d.moved && d.enterSubgraph) {
    openSubCanvas(d.enterSubgraph, d.id);
    return;
  }
  if (d?.moved) {
    try {
      if (d.childStarts.length) {
        const moves = [{ id: d.id, x: d.geom.x, y: d.geom.y }];
        const rdx = d.geom.x - d.start.x, rdy = d.geom.y - d.start.y;
        for (const ch of d.childStarts) moves.push({ id: ch.id, x: ch.x + rdx, y: ch.y + rdy });
        await api("PATCH", `/api/canvases/${encodeURIComponent(state.canvasId)}/positions`, { moves });
      } else {
        await api("PATCH", `/api/nodes/${d.id}`, d.geom);
      }
    } catch (err) { toast(`Move failed: ${err.message}`); }
  }
}
viewport.addEventListener("pointerup", endPointer);
viewport.addEventListener("pointercancel", endPointer);

viewport.addEventListener("click", async (e) => {
  const drill = e.target.closest("[data-drill]");
  if (drill) {
    const id = drill.closest(".node")?.dataset.id;
    openSubCanvas(drill.dataset.drill, id);
    return;
  }
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const id = b.closest(".node").dataset.id;
  const n = state.els.get(id)?.node;
  if (b.dataset.act === "inspect") select(id);
  if (b.dataset.act === "collapse") toggleCollapse(id);
  if (b.dataset.act === "edit") openEditor(id);
  if (b.dataset.act === "open") open(`/api/nodes/${id}/${n?.type === "html" ? "app" : "render"}`, "_blank");
  if (b.dataset.act === "del" && confirm(`Delete “${n?.title}”?`)) await api("DELETE", `/api/nodes/${id}`);
});

viewport.addEventListener("dblclick", (e) => {
  if (state.mode === "ui") return;
  // Pointer capture retargets the dblclick to the viewport, so fall back to the
  // node we recorded on pointerdown.
  const nodeEl = e.target.closest(".node") ||
    (state.downNode ? document.querySelector(`.node[data-id="${state.downNode}"]`) : null);
  if (nodeEl) {
    const n = state.els.get(nodeEl.dataset.id)?.node;
    if (n?.subCanvasId) openSubCanvas(n.subCanvasId, n.id);
    else if (n?.type === "group") toggleCollapse(n.id);
    else if (n?.type === "html") panToNode(n.id, { zoom: 1 }); // make the live app usable at 1:1
    return;
  }
  addItem(state.mode === "diagram" ? "card" : "note", toWorld(e.clientX, e.clientY));
});

viewport.addEventListener("wheel", (e) => {
  if (state.mode === "ui") return; // non-infinite workspace: never pan or zoom
  if (!(e.ctrlKey || e.metaKey) && e.target.closest(".body")) {
    const b = e.target.closest(".body");
    if (b.scrollHeight > b.clientHeight || b.scrollWidth > b.clientWidth) return;
  }
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0025)));
  else { cancelAnim(); state.view.x -= e.deltaX; state.view.y -= e.deltaY; applyView(); }
}, { passive: false });

// ---- toolbar & drawer events ----------------------------------------------------
$("#zoomIn").onclick = () => zoomAt(innerWidth / 2, innerHeight / 2, 1.25);
$("#zoomOut").onclick = () => zoomAt(innerWidth / 2, innerHeight / 2, 0.8);
$("#zoomPct").onclick = () => zoomAt(innerWidth / 2, innerHeight / 2, 1 / state.view.k);
$("#fit").onclick = () => fit(undefined, true);
$("#dockReset").onclick = () => {
  if (state.mode !== "ui" || !state.canvas) return;
  state.dockMaximized = null;
  state.dockLayout = dock.autoLayout(state.canvas.nodes);
  renderDock();
  persistDockLayout();
};
$("#dockRestoreAll").onclick = () => {
  if (state.mode !== "ui" || !state.dockLayout) return;
  state.dockLayout = dock.restoreAll(state.dockLayout);
  renderDock();
  persistDockLayout();
};
document.querySelectorAll("[data-add]").forEach((b) => (b.onclick = () => addItem(b.dataset.add)));
document.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
$("#linkMode").onclick = () => setLinking(!state.linking);
$("#canvasSel").onchange = (e) => loadCanvas(e.target.value);
$("#linkCanvas").onclick = openRelatedDialog;
$("#editLinks").onclick = openRelatedDialog;
$("#rdClose").onclick = () => $("#relatedDlg").close();
$("#rdDone").onclick = () => $("#relatedDlg").close();
$("#rdSearch").oninput = renderLinkDialog;
$("#relatedDlg").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$("#navBack").onclick = () => goNav(-1);
$("#navFwd").onclick = () => goNav(1);
$("#newCanvas").onclick = async () => {
  const name = prompt("Canvas name");
  if (!name) return;
  const c = await api("POST", "/api/canvases", { name, mode: state.mode });
  loadCanvas(c.id);
};
$("#delCanvas").onclick = async () => {
  if (!confirm(`Delete canvas “${state.canvas?.name}” and everything on it?`)) return;
  await api("DELETE", `/api/canvases/${encodeURIComponent(state.canvasId)}`);
  loadCanvas("main");
};

$("#flowPrev").onclick = () => stepFlow(-1);
$("#flowNext").onclick = () => stepFlow(1);
$("#insClose").onclick = () => select(null);
$("#insFocus").onclick = () => state.selected && panToNode(state.selected, { zoom: 1.05 });
$("#insEdit").onclick = () => state.selected && openEditor(state.selected);
$("#insOpen").onclick = () => state.selected && open(`/api/nodes/${state.selected}/render`, "_blank");

addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select, dialog")) return;
  if (state.mode !== "ui" && (e.key === "f" || e.key === "F")) fit(undefined, true);
  if (state.mode !== "ui" && (e.key === "l" || e.key === "L")) setLinking(!state.linking);
  if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); goNav(-1); return; }
  if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); goNav(1); return; }
  if (e.key === "Backspace") {
    if (navigateUp()) e.preventDefault();
  }
  if (e.key === "Escape") {
    if (state.mode === "ui" && state.dockMaximized) { state.dockMaximized = null; renderDock(); }
    else if (state.linking) setLinking(false);
    else if (state.selected || state.flowId) select(null);
    else navigateUp();
  }
  if (state.flowId && e.key === "ArrowLeft") { e.preventDefault(); stepFlow(-1); }
  if (state.flowId && e.key === "ArrowRight") { e.preventDefault(); stepFlow(1); }
});

// ---- boot ----------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const hashNode = new URLSearchParams(location.hash.slice(1)).get("node");
await loadCanvas(params.get("canvas") || "main", { focus: hashNode || undefined });
connectEvents();
migrateLocalLinks();
libsReady.then(() => {
  if (!state.canvas) return;
  for (const rec of state.els.values()) {
    if (rec.node.type === "note" || rec.node.type === "diagram") fillBody(rec, rec.node);
  }
  renderInspector();
});
