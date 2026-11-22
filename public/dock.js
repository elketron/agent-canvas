// Pure dockable-workspace layout engine for Agent Canvas "ui" mode.
// Layout schema:
//   DockLayout = { root: DockNode | null, minimized?: string[] }
//   DockNode   = { type: "split", dir: "row" | "col", children: DockNode[], sizes: number[] }
//              | { type: "pane", id: string, tabs: string[], active: string }

const MIN_SPLIT_PCT = 10;

export function shortPaneId() {
  return `p-${Math.random().toString(36).slice(2, 8)}`;
}

export function cloneLayout(layout) {
  if (!layout) return { root: null, minimized: [] };
  return JSON.parse(JSON.stringify(layout));
}

export function dockableNodes(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const nonGroups = list.filter((n) => n.type !== "group");
  return nonGroups.length ? nonGroups : list;
}

function makePane(tabs, active) {
  return { type: "pane", id: shortPaneId(), tabs: [...tabs], active: active ?? tabs[0] };
}

function makeSplit(dir, children, sizes) {
  const raw = sizes && sizes.length === children.length ? sizes : children.map(() => 100 / children.length);
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  return {
    type: "split",
    dir,
    children,
    sizes: raw.map((s) => Number(((s / sum) * 100).toFixed(3))),
  };
}

/** Build a clean initial non-infinite tiled layout for a list of canvas nodes. */
export function autoLayout(nodes) {
  const list = dockableNodes(nodes);
  if (!list.length) return { root: null, minimized: [] };
  if (list.length === 1) return { root: makePane([list[0].id]), minimized: [] };

  if (list.length === 2) {
    const w0 = Math.max(200, Number(list[0].w) || 500);
    const w1 = Math.max(200, Number(list[1].w) || 500);
    const ratio = Math.min(68, Math.max(32, Math.round((w0 / (w0 + w1)) * 100)));
    return {
      root: makeSplit("row", [makePane([list[0].id]), makePane([list[1].id])], [ratio, 100 - ratio]),
      minimized: [],
    };
  }

  if (list.length === 3) {
    const left = makePane([list[0].id]);
    const right = makeSplit("col", [makePane([list[1].id]), makePane([list[2].id])], [50, 50]);
    return { root: makeSplit("row", [left, right], [52, 48]), minimized: [] };
  }

  // 4+ boards: distribute across 2 or 3 columns, stacking each column vertically.
  const colCount = list.length <= 4 ? 2 : 3;
  const cols = Array.from({ length: colCount }, () => []);
  // Balance columns cleanly (e.g. 5 items -> 2, 2, 1; 6 items -> 2, 2, 2)
  const base = Math.floor(list.length / colCount);
  const extra = list.length % colCount;
  let cursor = 0;
  for (let c = 0; c < colCount; c++) {
    const take = base + (c < extra ? 1 : 0);
    for (let i = 0; i < take && cursor < list.length; i++) cols[c].push(list[cursor++]);
  }

  const colNodes = cols.map((col) => {
    if (col.length === 1) return makePane([col[0].id]);
    return makeSplit("col", col.map((n) => makePane([n.id])));
  });

  // Weight columns lightly by the widest board in each column (clamped)
  const weights = cols.map((col) => {
    const maxW = Math.max(...col.map((n) => Number(n.w) || 480));
    return Math.min(720, Math.max(320, maxW));
  });

  return { root: makeSplit("row", colNodes, weights), minimized: [] };
}

function cleanNode(node, validIds, seen) {
  if (!node || typeof node !== "object") return null;
  if (node.type === "pane") {
    const tabs = [];
    for (const id of Array.isArray(node.tabs) ? node.tabs : []) {
      const sid = String(id);
      if (!validIds.has(sid) || seen.has(sid)) continue;
      seen.add(sid);
      tabs.push(sid);
    }
    if (!tabs.length) return null;
    const active = node.active && tabs.includes(node.active) ? node.active : tabs[0];
    return { type: "pane", id: node.id || shortPaneId(), tabs, active };
  }
  if (node.type === "split" && (node.dir === "row" || node.dir === "col") && Array.isArray(node.children)) {
    const children = [];
    const sizes = [];
    const rawSizes = Array.isArray(node.sizes) ? node.sizes : [];
    for (let i = 0; i < node.children.length; i++) {
      const cleaned = cleanNode(node.children[i], validIds, seen);
      if (!cleaned) continue;
      const sz = typeof rawSizes[i] === "number" && Number.isFinite(rawSizes[i]) && rawSizes[i] > 0 ? rawSizes[i] : 1;
      // Flatten nested split with same direction
      if (cleaned.type === "split" && cleaned.dir === node.dir) {
        const subTotal = cleaned.sizes.reduce((a, b) => a + b, 0) || 1;
        for (let j = 0; j < cleaned.children.length; j++) {
          children.push(cleaned.children[j]);
          sizes.push(sz * (cleaned.sizes[j] / subTotal));
        }
      } else {
        children.push(cleaned);
        sizes.push(sz);
      }
    }
    if (!children.length) return null;
    if (children.length === 1) return children[0];
    return makeSplit(node.dir, children, sizes);
  }
  return null;
}

/** Insert a single nodeId into an existing tree by splitting the best available pane. */
function insertAuto(root, nodeId) {
  if (!root) return makePane([nodeId]);
  if (root.type === "pane") {
    return makeSplit("row", [root, makePane([nodeId])], [55, 45]);
  }
  if (root.dir === "row" && root.children.length < 3) {
    const share = Math.round(100 / (root.children.length + 1));
    const scale = (100 - share) / 100;
    return makeSplit(
      "row",
      [...root.children, makePane([nodeId])],
      [...root.sizes.map((s) => s * scale), share],
    );
  }
  // Find the pane with the largest estimated relative area and split it along its wider/taller axis
  let best = null;
  function walk(node, w, h, replace) {
    if (node.type === "pane") {
      const area = w * h;
      if (!best || area > best.area) best = { node, w, h, area, replace };
      return;
    }
    const sum = node.sizes.reduce((a, b) => a + b, 0) || 1;
    node.children.forEach((ch, idx) => {
      const frac = node.sizes[idx] / sum;
      const cw = node.dir === "row" ? w * frac : w;
      const chH = node.dir === "col" ? h * frac : h;
      walk(ch, cw, chH, (next) => { node.children[idx] = next; });
    });
  }
  walk(root, 1600, 900, () => {});
  if (best) {
    const dir = best.w >= best.h * 1.15 ? "row" : "col";
    best.replace(makeSplit(dir, [best.node, makePane([nodeId])], [50, 50]));
  }
  return root;
}

/** Reconcile a persisted layout against the current canvas nodes. */
export function normalizeLayout(layout, nodes) {
  const list = dockableNodes(nodes);
  if (!list.length) return { root: null, minimized: [] };
  const validIds = new Set(list.map((n) => n.id));

  if (!layout || (!layout.root && !(layout.minimized && layout.minimized.length))) {
    return autoLayout(list);
  }

  const seen = new Set();
  let root = cleanNode(layout.root, validIds, seen);
  const minimized = [];
  for (const m of Array.isArray(layout.minimized) ? layout.minimized : []) {
    const sid = String(m);
    if (!validIds.has(sid) || seen.has(sid)) continue;
    seen.add(sid);
    minimized.push(sid);
  }

  // Dock any newly added nodes that aren't placed or minimized yet
  const unplaced = list.filter((n) => !seen.has(n.id));
  if (unplaced.length) {
    if (!root && !minimized.length) {
      return autoLayout(list);
    }
    for (const n of unplaced) {
      root = insertAuto(root, n.id);
    }
    // Flatten/normalize once more after insertions
    root = cleanNode(root, validIds, new Set());
  }

  return minimized.length ? { root, minimized } : { root };
}

/** Remove a nodeId from anywhere in the layout (root or minimized) without auto-re-adding it. */
function removeNodeFromTree(node, nodeId) {
  if (!node) return null;
  if (node.type === "pane") {
    const idx = node.tabs.indexOf(nodeId);
    if (idx < 0) return node;
    const tabs = node.tabs.filter((t) => t !== nodeId);
    if (!tabs.length) return null;
    const active = node.active === nodeId ? tabs[Math.min(idx, tabs.length - 1)] : node.active;
    return { ...node, tabs, active };
  }
  if (node.type === "split") {
    const children = [];
    const sizes = [];
    for (let i = 0; i < node.children.length; i++) {
      const next = removeNodeFromTree(node.children[i], nodeId);
      if (next) {
        children.push(next);
        sizes.push(node.sizes[i]);
      }
    }
    if (!children.length) return null;
    if (children.length === 1) return children[0];
    return makeSplit(node.dir, children, sizes);
  }
  return node;
}

function finalizeTree(node) {
  if (!node) return null;
  if (node.type === "pane") return node.tabs.length ? node : null;
  const children = [];
  const sizes = [];
  for (let i = 0; i < node.children.length; i++) {
    const ch = finalizeTree(node.children[i]);
    if (!ch) continue;
    const sz = node.sizes[i];
    if (ch.type === "split" && ch.dir === node.dir) {
      const subTotal = ch.sizes.reduce((a, b) => a + b, 0) || 1;
      for (let j = 0; j < ch.children.length; j++) {
        children.push(ch.children[j]);
        sizes.push(sz * (ch.sizes[j] / subTotal));
      }
    } else {
      children.push(ch);
      sizes.push(sz);
    }
  }
  if (!children.length) return null;
  if (children.length === 1) return children[0];
  return makeSplit(node.dir, children, sizes);
}

export function findPaneOfNode(root, nodeId) {
  if (!root) return null;
  if (root.type === "pane") return root.tabs.includes(nodeId) ? root : null;
  for (const ch of root.children) {
    const found = findPaneOfNode(ch, nodeId);
    if (found) return found;
  }
  return null;
}

export function findPaneById(root, paneId) {
  if (!root) return null;
  if (root.type === "pane") return root.id === paneId ? root : null;
  for (const ch of root.children) {
    const found = findPaneById(ch, paneId);
    if (found) return found;
  }
  return null;
}

export function countPanes(root) {
  if (!root) return 0;
  if (root.type === "pane") return 1;
  return root.children.reduce((acc, ch) => acc + countPanes(ch), 0);
}

export function findSplitByPath(root, path) {
  let cur = root;
  for (const idx of path) {
    if (!cur || cur.type !== "split" || !cur.children[idx]) return null;
    cur = cur.children[idx];
  }
  return cur?.type === "split" ? cur : null;
}

/** Dock nodeId into targetPaneId at zone ("left" | "right" | "top" | "bottom" | "center"). */
export function dockTab(layout, nodeId, targetPaneId, zone, insertIndex = null) {
  const next = cloneLayout(layout);
  const sourcePane = findPaneOfNode(next.root, nodeId);
  if (sourcePane && sourcePane.id === targetPaneId) {
    if (sourcePane.tabs.length <= 1) return next; // sole tab onto itself: no-op
    if (zone === "center") {
      // Reorder tab within the same pane
      if (typeof insertIndex === "number") {
        return reorderTab(next, targetPaneId, nodeId, insertIndex);
      }
      return next;
    }
  }

  // Remove from current location (either root or minimized)
  next.minimized = (next.minimized || []).filter((id) => id !== nodeId);
  next.root = removeNodeFromTree(next.root, nodeId);

  if (!next.root) {
    next.root = makePane([nodeId]);
    if (!next.minimized.length) delete next.minimized;
    return next;
  }

  function apply(node) {
    if (!node) return null;
    if (node.type === "pane") {
      if (node.id !== targetPaneId) return node;
      if (zone === "center") {
        const tabs = [...node.tabs];
        if (typeof insertIndex === "number" && insertIndex >= 0 && insertIndex <= tabs.length) {
          tabs.splice(insertIndex, 0, nodeId);
        } else {
          tabs.push(nodeId);
        }
        return { ...node, tabs, active: nodeId };
      }
      const fresh = makePane([nodeId]);
      const dir = zone === "left" || zone === "right" ? "row" : "col";
      const before = zone === "left" || zone === "top";
      return makeSplit(dir, before ? [fresh, node] : [node, fresh], [50, 50]);
    }
    return { ...node, children: node.children.map(apply) };
  }

  next.root = finalizeTree(apply(next.root));
  if (!next.minimized?.length) delete next.minimized;
  return next;
}

/** Dock nodeId along an outer edge of the entire workspace ("left" | "right" | "top" | "bottom"). */
export function dockToEdge(layout, nodeId, edge) {
  const next = cloneLayout(layout);
  next.minimized = (next.minimized || []).filter((id) => id !== nodeId);
  next.root = removeNodeFromTree(next.root, nodeId);

  const fresh = makePane([nodeId]);
  if (!next.root) {
    next.root = fresh;
  } else {
    const dir = edge === "left" || edge === "right" ? "row" : "col";
    const before = edge === "left" || edge === "top";
    const share = countPanes(next.root) === 1 ? 50 : 32;
    next.root = finalizeTree(
      makeSplit(dir, before ? [fresh, next.root] : [next.root, fresh], before ? [share, 100 - share] : [100 - share, share]),
    );
  }
  if (!next.minimized?.length) delete next.minimized;
  return next;
}

export function reorderTab(layout, paneId, nodeId, targetIndex) {
  const next = cloneLayout(layout);
  const pane = findPaneById(next.root, paneId);
  if (!pane) return next;
  const from = pane.tabs.indexOf(nodeId);
  if (from < 0) return next;
  pane.tabs.splice(from, 1);
  const clamped = Math.max(0, Math.min(pane.tabs.length, targetIndex));
  pane.tabs.splice(clamped, 0, nodeId);
  pane.active = nodeId;
  return next;
}

export function activateTab(layout, paneId, nodeId) {
  const next = cloneLayout(layout);
  const pane = findPaneById(next.root, paneId);
  if (pane && pane.tabs.includes(nodeId)) pane.active = nodeId;
  return next;
}

export function minimizeNode(layout, nodeId) {
  const next = cloneLayout(layout);
  next.root = finalizeTree(removeNodeFromTree(next.root, nodeId));
  const min = new Set(next.minimized || []);
  min.add(nodeId);
  next.minimized = [...min];
  return next;
}

export function restoreNode(layout, nodeId) {
  const next = cloneLayout(layout);
  next.minimized = (next.minimized || []).filter((id) => id !== nodeId);
  if (!findPaneOfNode(next.root, nodeId)) {
    next.root = finalizeTree(insertAuto(next.root, nodeId));
  }
  if (!next.minimized.length) delete next.minimized;
  return next;
}

export function restoreAll(layout) {
  const next = cloneLayout(layout);
  const list = [...(next.minimized || [])];
  delete next.minimized;
  for (const id of list) {
    if (!findPaneOfNode(next.root, id)) {
      next.root = finalizeTree(insertAuto(next.root, id));
    }
  }
  return next;
}

export function resizeSplitAt(layout, path, index, newSizeA, newSizeB) {
  const split = findSplitByPath(layout.root, path);
  if (!split || index < 0 || index + 1 >= split.sizes.length) return false;
  const pairTotal = split.sizes[index] + split.sizes[index + 1];
  const minSz = Math.min(MIN_SPLIT_PCT, pairTotal / 2);
  const a = Math.max(minSz, Math.min(pairTotal - minSz, newSizeA));
  const b = pairTotal - a;
  split.sizes[index] = Number(a.toFixed(3));
  split.sizes[index + 1] = Number(b.toFixed(3));
  return true;
}

export function equalizeSplitAt(layout, path, index) {
  const next = cloneLayout(layout);
  const split = findSplitByPath(next.root, path);
  if (!split || index < 0 || index + 1 >= split.sizes.length) return next;
  const avg = Number(((split.sizes[index] + split.sizes[index + 1]) / 2).toFixed(3));
  split.sizes[index] = avg;
  split.sizes[index + 1] = avg;
  return next;
}

/**
 * Recursively compute pixel rectangles for all panes and splitters within `box`.
 */
export function computeRects(root, box, gap = 8) {
  const panes = new Map();
  const splitters = [];
  if (!root || box.w <= 0 || box.h <= 0) return { panes, splitters };

  function walk(node, rect, path) {
    if (node.type === "pane") {
      panes.set(node.id, {
        pane: node,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.max(1, Math.round(rect.w)),
        h: Math.max(1, Math.round(rect.h)),
      });
      return;
    }
    const n = node.children.length;
    const totalGap = gap * Math.max(0, n - 1);
    const isRow = node.dir === "row";
    const avail = Math.max(1, (isRow ? rect.w : rect.h) - totalGap);
    const sum = node.sizes.reduce((a, b) => a + b, 0) || 1;
    let offset = isRow ? rect.x : rect.y;

    for (let i = 0; i < n; i++) {
      const isLast = i === n - 1;
      const span = isLast
        ? Math.max(1, (isRow ? rect.x + rect.w : rect.y + rect.h) - offset)
        : (avail * node.sizes[i]) / sum;
      const childRect = isRow
        ? { x: offset, y: rect.y, w: span, h: rect.h }
        : { x: rect.x, y: offset, w: rect.w, h: span };
      walk(node.children[i], childRect, [...path, i]);

      if (!isLast) {
        const sPos = offset + span;
        splitters.push({
          path,
          dir: node.dir,
          index: i,
          parentSpan: avail,
          x: Math.round(isRow ? sPos : rect.x),
          y: Math.round(isRow ? rect.y : sPos),
          w: Math.round(isRow ? gap : rect.w),
          h: Math.round(isRow ? rect.h : gap),
        });
      }
      offset += span + gap;
    }
  }

  walk(root, box, []);
  return { panes, splitters };
}

/**
 * Determine the dock drop target under the pointer.
 */
export function hitTestDockTarget(clientX, clientY, rects, box, drag, tabHeaderH = 36) {
  if (!box || box.w <= 0 || box.h <= 0) return null;

  // Empty workspace (e.g., all boards were minimized)
  if (!rects.panes.size) {
    if (clientX >= box.x && clientX <= box.x + box.w && clientY >= box.y && clientY <= box.y + box.h) {
      return {
        kind: "edge",
        edge: "left",
        label: "Dock to workspace",
        preview: { x: box.x, y: box.y, w: box.w, h: box.h },
      };
    }
    return null;
  }

  // Outer workspace edge zones (dock full-height or full-width)
  const canDockEdge = rects.panes.size > 1 || drag.fromShelf || drag.sourceTabCount > 1;
  const edgeMargin = 22;
  if (canDockEdge && clientX >= box.x - 16 && clientX <= box.x + box.w + 16 && clientY >= box.y - 16 && clientY <= box.y + box.h + 16) {
    if (clientX - box.x <= edgeMargin) {
      return {
        kind: "edge",
        edge: "left",
        label: "Dock Left Edge",
        preview: { x: box.x, y: box.y, w: Math.round(box.w * 0.32), h: box.h },
      };
    }
    if (box.x + box.w - clientX <= edgeMargin) {
      const w = Math.round(box.w * 0.32);
      return {
        kind: "edge",
        edge: "right",
        label: "Dock Right Edge",
        preview: { x: box.x + box.w - w, y: box.y, w, h: box.h },
      };
    }
    if (clientY - box.y <= edgeMargin) {
      return {
        kind: "edge",
        edge: "top",
        label: "Dock Top Edge",
        preview: { x: box.x, y: box.y, w: box.w, h: Math.round(box.h * 0.32) },
      };
    }
    if (box.y + box.h - clientY <= edgeMargin) {
      const h = Math.round(box.h * 0.32);
      return {
        kind: "edge",
        edge: "bottom",
        label: "Dock Bottom Edge",
        preview: { x: box.x, y: box.y + box.h - h, w: box.w, h },
      };
    }
  }

  // Pane hit-testing
  for (const [paneId, r] of rects.panes) {
    if (clientX < r.x || clientX > r.x + r.w || clientY < r.y || clientY > r.y + r.h) continue;
    const isSameSolePane = paneId === drag.sourcePaneId && drag.sourceTabCount <= 1;
    if (isSameSolePane) return null;

    const relX = clientX - r.x;
    const relY = clientY - r.y;

    // Hovering over the pane's tab header bar -> stack as tab / reorder tab
    if (relY <= tabHeaderH) {
      return {
        kind: "pane",
        paneId,
        zone: "center",
        overTabBar: true,
        label: paneId === drag.sourcePaneId ? "Reorder Tab" : "Stack as Tab",
        preview: { x: r.x, y: r.y, w: r.w, h: tabHeaderH },
      };
    }

    const rx = relX / Math.max(1, r.w);
    const ry = (relY - tabHeaderH) / Math.max(1, r.h - tabHeaderH);
    const band = 0.27;

    // Check which side band (if any) is closest
    const candidates = [];
    if (rx < band) candidates.push({ zone: "left", dist: rx });
    if (rx > 1 - band) candidates.push({ zone: "right", dist: 1 - rx });
    if (ry < band) candidates.push({ zone: "top", dist: ry });
    if (ry > 1 - band) candidates.push({ zone: "bottom", dist: 1 - ry });

    if (candidates.length) {
      candidates.sort((a, b) => a.dist - b.dist);
      const zone = candidates[0].zone;
      const halfW = Math.round(r.w / 2);
      const halfH = Math.round(r.h / 2);
      const preview =
        zone === "left" ? { x: r.x, y: r.y, w: halfW, h: r.h }
          : zone === "right" ? { x: r.x + r.w - halfW, y: r.y, w: halfW, h: r.h }
          : zone === "top" ? { x: r.x, y: r.y, w: r.w, h: halfH }
          : { x: r.x, y: r.y + r.h - halfH, w: r.w, h: halfH };
      const labels = { left: "Split Left", right: "Split Right", top: "Split Top", bottom: "Split Bottom" };
      return { kind: "pane", paneId, zone, label: labels[zone], preview };
    }

    // Center zone -> stack as tab (no-op if dragging own tab onto own body center)
    if (paneId === drag.sourcePaneId) return null;
    return {
      kind: "pane",
      paneId,
      zone: "center",
      label: "Stack as Tab",
      preview: { x: r.x, y: r.y, w: r.w, h: r.h },
    };
  }

  return null;
}
