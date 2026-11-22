// File-backed store: one JSON file per canvas in data/canvases/.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export type NodeType = "html" | "diagram" | "note" | "card" | "group";
export type CanvasMode = "board" | "diagram" | "ui";
export type Author = "agent" | "user";

export type DockNode =
  | {
      type: "split";
      dir: "row" | "col";
      children: DockNode[];
      sizes: number[];
    }
  | {
      type: "pane";
      id: string;
      tabs: string[];
      active?: string;
    };

export interface DockLayout {
  root: DockNode | null;
  minimized?: string[];
}

export interface Version { title: string; content: string; at: string }

export interface CanvasNode {
  id: string;
  type: NodeType;
  title: string;
  content: string; // html source | mermaid source | markdown (details for card/group)
  subtitle?: string;
  group?: string;
  color?: string;
  meta?: string;
  parentId?: string;    // parent group node id (for in-canvas subgraphs)
  collapsed?: boolean;  // for group nodes: collapses children & reroutes edges
  subCanvasId?: string; // optional drill-down child canvas id
  state?: unknown;      // live app state for html nodes (set via canvas.state, not versioned)
  x: number; y: number; w: number; h: number;
  author: Author;
  rev: number; // bumps when title/content/card metadata change (not on move/resize)
  createdAt: string;
  updatedAt: string;
  history: Version[]; // previous versions, newest last
}

export interface Edge { id: string; from: string; to: string; label?: string }

export interface FlowStep {
  nodeId: string;
  caption: string;
  edges?: string[];
}

export interface CanvasFlow {
  id: string;
  name: string;
  steps: FlowStep[];
}

export interface Canvas {
  id: string;
  name: string;
  mode?: CanvasMode;
  layout?: DockLayout; // dockable workspace layout (used in mode="ui")
  parentCanvasId?: string;
  flows?: CanvasFlow[];
  links?: string[]; // related canvas ids (symmetric, persisted with both canvases)
  createdAt: string;
  updatedAt: string;
  nodes: CanvasNode[];
  edges: Edge[];
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const DATA_DIR = process.env.CANVAS_DATA_DIR ?? join(import.meta.dir, "..", "data", "canvases");
mkdirSync(DATA_DIR, { recursive: true });

const MAX_HISTORY = 25;
const GAP = 80;
const WRAP_X = 4200;

export const DEFAULT_SIZE: Record<NodeType, { w: number; h: number }> = {
  html: { w: 960, h: 640 },
  diagram: { w: 720, h: 480 },
  note: { w: 300, h: 220 },
  card: { w: 260, h: 118 },
  group: { w: 620, h: 360 },
};

const canvases = new Map<string, Canvas>();
for (const f of readdirSync(DATA_DIR)) {
  if (!f.endsWith(".json")) continue;
  try {
    const c = JSON.parse(readFileSync(join(DATA_DIR, f), "utf8")) as Canvas;
    canvases.set(c.id, c);
  } catch (e) {
    console.error(`skipping unreadable canvas file ${f}:`, e);
  }
}
// Normalise related-canvas links: unique, no self-links, only existing canvases.
for (const c of canvases.values()) {
  if (!Array.isArray(c.links)) { delete c.links; continue; }
  const links = [...new Set(c.links.map(String))].filter((id) => id !== c.id && canvases.has(id));
  if (links.length) c.links = links;
  else delete c.links;
}

const now = () => new Date().toISOString();
const shortId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 8);
const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "canvas";

function save(c: Canvas) {
  c.updatedAt = now();
  writeFileSync(join(DATA_DIR, `${c.id}.json`), JSON.stringify(c, null, 2));
}

export function listCanvases() {
  return [...canvases.values()]
    .map((c) => ({
      id: c.id,
      name: c.name,
      mode: c.mode ?? "board",
      ...(c.parentCanvasId ? { parentCanvasId: c.parentCanvasId } : {}),
      links: c.links ?? [],
      nodes: c.nodes.length,
      updatedAt: c.updatedAt,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getCanvas(id: string): Canvas {
  const c = canvases.get(id);
  if (!c) {
    if (id === "main") return createCanvas("main");
    throw new HttpError(404, `canvas "${id}" not found`);
  }
  return c;
}

function parseMode(mode: unknown): CanvasMode {
  return mode === "diagram" ? "diagram" : mode === "ui" ? "ui" : "board";
}

function sanitizeDockNode(
  raw: any,
  seen: Set<string>,
  mapId?: (id: string) => string | undefined,
): DockNode | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.type === "pane") {
    const rawTabs = Array.isArray(raw.tabs) ? raw.tabs : [];
    const tabs: string[] = [];
    for (const t of rawTabs) {
      const mapped = mapId ? mapId(String(t)) : String(t);
      if (!mapped || seen.has(mapped)) continue;
      seen.add(mapped);
      tabs.push(mapped);
    }
    if (!tabs.length) return null;
    const rawActive = raw.active !== undefined ? (mapId ? mapId(String(raw.active)) : String(raw.active)) : undefined;
    const active = rawActive && tabs.includes(rawActive) ? rawActive : tabs[0];
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `p-${shortId()}`;
    return { type: "pane", id, tabs, active };
  }
  if (raw.type === "split" && (raw.dir === "row" || raw.dir === "col") && Array.isArray(raw.children)) {
    const children: DockNode[] = [];
    const sizes: number[] = [];
    const rawSizes = Array.isArray(raw.sizes) ? raw.sizes : [];
    for (let i = 0; i < raw.children.length; i++) {
      const ch = sanitizeDockNode(raw.children[i], seen, mapId);
      if (!ch) continue;
      const sz = typeof rawSizes[i] === "number" && Number.isFinite(rawSizes[i]) && rawSizes[i] > 0 ? rawSizes[i] : 1;
      children.push(ch);
      sizes.push(sz);
    }
    if (!children.length) return null;
    if (children.length === 1) return children[0];
    const total = sizes.reduce((a, b) => a + b, 0) || 1;
    return { type: "split", dir: raw.dir, children, sizes: sizes.map((s) => Number(((s / total) * 100).toFixed(3))) };
  }
  return null;
}

function sanitizeDockLayout(raw: unknown, mapId?: (id: string) => string | undefined): DockLayout | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as any;
  const seen = new Set<string>();
  const root = sanitizeDockNode(obj.root, seen, mapId);
  const minimized: string[] = [];
  if (Array.isArray(obj.minimized)) {
    for (const m of obj.minimized) {
      const mapped = mapId ? mapId(String(m)) : String(m);
      if (!mapped || seen.has(mapped)) continue;
      seen.add(mapped);
      minimized.push(mapped);
    }
  }
  if (!root && !minimized.length) return { root: null };
  return minimized.length ? { root, minimized } : { root };
}

export function createCanvas(name: string, mode: CanvasMode = "board", parentCanvasId?: string): Canvas {
  let id = slugify(name);
  for (let i = 2; canvases.has(id); i++) id = `${slugify(name)}-${i}`;
  const validMode = parseMode(mode);
  const c: Canvas = {
    id,
    name,
    mode: validMode,
    ...(parentCanvasId ? { parentCanvasId: String(parentCanvasId) } : {}),
    createdAt: now(),
    updatedAt: now(),
    nodes: [],
    edges: [],
    links: [],
  };
  canvases.set(id, c);
  save(c);
  return c;
}

export function updateCanvas(
  id: string,
  patch: {
    name?: string;
    mode?: CanvasMode;
    layout?: DockLayout | null;
    parentCanvasId?: string | null;
    flows?: CanvasFlow[];
  },
): Canvas {
  const c = getCanvas(id);
  if (patch.name !== undefined && String(patch.name).trim()) c.name = String(patch.name).trim();
  if (patch.mode === "board" || patch.mode === "diagram" || patch.mode === "ui") c.mode = patch.mode;
  if (patch.layout !== undefined) {
    if (patch.layout === null) delete c.layout;
    else {
      const validIds = new Set(c.nodes.map((n) => n.id));
      const clean = sanitizeDockLayout(patch.layout, (nid) => (validIds.has(nid) ? nid : undefined));
      if (clean) c.layout = clean;
      else delete c.layout;
    }
  }
  if (patch.parentCanvasId !== undefined) {
    if (patch.parentCanvasId) c.parentCanvasId = String(patch.parentCanvasId);
    else delete c.parentCanvasId;
  }
  if (Array.isArray(patch.flows)) {
    c.flows = patch.flows
      .filter((f) => f && typeof f.name === "string" && Array.isArray(f.steps))
      .map((f) => ({
        id: f.id ? String(f.id) : slugify(f.name),
        name: String(f.name),
        steps: f.steps
          .filter((s) => s && typeof s.nodeId === "string")
          .map((s) => ({
            nodeId: String(s.nodeId),
            caption: String(s.caption ?? ""),
            ...(Array.isArray(s.edges) ? { edges: s.edges.map(String) } : {}),
          })),
      }));
  }
  save(c);
  return c;
}

export function deleteCanvas(id: string): string[] {
  if (!canvases.delete(id)) throw new HttpError(404, `canvas "${id}" not found`);
  rmSync(join(DATA_DIR, `${id}.json`), { force: true });
  const affected: string[] = [];
  for (const other of canvases.values()) {
    if (!Array.isArray(other.links) || !other.links.includes(id)) continue;
    other.links = other.links.filter((x) => x !== id);
    if (!other.links.length) delete other.links;
    save(other);
    affected.push(other.id);
  }
  return affected;
}

/** Link or unlink two canvases as related. Links are symmetric and idempotent. */
export function linkCanvases(a: string, b: string, on = true): { canvas: Canvas; linked: Canvas } {
  if (a === b) throw new HttpError(400, "a canvas cannot link to itself");
  const ca = getCanvas(a);
  const cb = getCanvas(b);
  const apply = (from: Canvas, to: string) => {
    const set = new Set(Array.isArray(from.links) ? from.links : []);
    if (on) set.add(to); else set.delete(to);
    const next = [...set].filter((id) => id !== from.id && canvases.has(id));
    if (next.length) from.links = next;
    else delete from.links;
  };
  apply(ca, cb.id);
  apply(cb, ca.id);
  save(ca);
  save(cb);
  return { canvas: ca, linked: cb };
}

export interface ImportedCanvas { originalId: string; id: string; name: string }

const NODE_TYPES: NodeType[] = ["html", "diagram", "note", "card", "group"];

/**
 * Import canvas snapshots as new canvases. IDs are always remapped so an import
 * never overwrites anything; references (links, parents, subCanvasId, edges,
 * group parents, flow steps) are remapped when their target is in the batch.
 */
export function importCanvasSnapshots(snapshots: Canvas[], namePrefix = ""): ImportedCanvas[] {
  if (!Array.isArray(snapshots) || !snapshots.length) throw new HttpError(400, "no canvases to import");

  const seen = new Set<string>();
  const prepared = snapshots.map((raw, i) => {
    if (!raw || typeof raw !== "object") throw new HttpError(400, `canvas ${i + 1} is not an object`);
    const data = raw as any;
    if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
      throw new HttpError(400, `canvas ${i + 1} is missing nodes/edges arrays`);
    }
    const originalId = optStr(data.id) ?? `import-${i + 1}`;
    if (seen.has(originalId)) throw new HttpError(400, `duplicate canvas id "${originalId}" in bundle`);
    seen.add(originalId);
    const baseName = optStr(data.name) ?? originalId;
    return {
      originalId,
      raw: data,
      name: namePrefix ? `${namePrefix}${baseName}` : baseName,
      mode: parseMode(data.mode),
    };
  });

  // Pass 1: create empty shells with fresh canvas ids.
  const idMap = new Map<string, string>();
  const shells = prepared.map((p) => {
    const canvas = createCanvas(p.name, p.mode);
    idMap.set(p.originalId, canvas.id);
    return { p, canvas };
  });
  const remapCanvas = (id: unknown) => {
    const key = optStr(id);
    return key ? idMap.get(key) : undefined;
  };

  // Node and edge ids are globally unique in this store — allocate fresh ones.
  const usedNodeIds = new Set<string>();
  for (const c of canvases.values()) for (const n of c.nodes) usedNodeIds.add(n.id);
  const usedEdgeIds = new Set<string>();
  for (const c of canvases.values()) for (const e of c.edges) usedEdgeIds.add(e.id);
  const newNodeId = () => {
    let id = shortId();
    while (usedNodeIds.has(id)) id = shortId();
    usedNodeIds.add(id);
    return id;
  };
  const newEdgeId = () => {
    let id = `e-${shortId()}`;
    while (usedEdgeIds.has(id)) id = `e-${shortId()}`;
    usedEdgeIds.add(id);
    return id;
  };

  // Pass 2: rebuild nodes/edges/flows with remapped references.
  for (const { p, canvas } of shells) {
    const data = p.raw;
    const rawNodes: any[] = data.nodes;
    const nodeIdMap = new Map<string, string>();
    for (const rn of rawNodes) {
      if (!rn || typeof rn !== "object") continue;
      const oldId = optStr(rn.id);
      if (!oldId || nodeIdMap.has(oldId)) continue;
      nodeIdMap.set(oldId, newNodeId());
    }

    const nodes: CanvasNode[] = [];
    for (const rn of rawNodes) {
      if (!rn || typeof rn !== "object") continue;
      const oldId = optStr(rn.id);
      const newId = oldId ? nodeIdMap.get(oldId) : undefined;
      if (!oldId || !newId) continue;
      const type: NodeType = NODE_TYPES.includes(rn.type) ? rn.type : "note";
      const size = DEFAULT_SIZE[type];
      const parentOld = optStr(rn.parentId);
      const parentId = parentOld && parentOld !== oldId ? nodeIdMap.get(parentOld) : undefined;
      const subCanvasId = remapCanvas(rn.subCanvasId);
      const subtitle = optStr(rn.subtitle);
      const group = optStr(rn.group);
      const color = optStr(rn.color);
      const meta = optStr(rn.meta);
      const state = rn.state !== undefined && rn.state !== null ? normaliseState(rn.state) : undefined;
      const rawHistory: any[] = Array.isArray(rn.history) ? rn.history : [];
      const history: Version[] = rawHistory
        .filter((v) => v && typeof v.title === "string" && typeof v.content === "string")
        .slice(-MAX_HISTORY)
        .map((v) => ({
          title: String(v.title),
          content: String(v.content),
          at: typeof v.at === "string" ? v.at : now(),
        }));
      nodes.push({
        id: newId,
        type,
        title: String(rn.title ?? "Imported item"),
        content: String(rn.content ?? ""),
        ...(subtitle ? { subtitle } : {}),
        ...(group ? { group } : {}),
        ...(color ? { color } : {}),
        ...(meta ? { meta } : {}),
        ...(parentId ? { parentId } : {}),
        ...(type === "group" && rn.collapsed ? { collapsed: true } : {}),
        ...(subCanvasId ? { subCanvasId } : {}),
        ...(state !== undefined ? { state } : {}),
        x: num(rn.x) ?? 0,
        y: num(rn.y) ?? 0,
        w: Math.max(80, num(rn.w) ?? size.w),
        h: Math.max(80, num(rn.h) ?? size.h),
        author: rn.author === "user" ? "user" : "agent",
        rev: Math.max(1, num(rn.rev) ?? 1),
        createdAt: typeof rn.createdAt === "string" ? rn.createdAt : now(),
        updatedAt: typeof rn.updatedAt === "string" ? rn.updatedAt : now(),
        history,
      });
    }

    const edgeIdMap = new Map<string, string>();
    const edges: Edge[] = [];
    for (const re of Array.isArray(data.edges) ? data.edges : []) {
      if (!re || typeof re !== "object") continue;
      const from = nodeIdMap.get(optStr(re.from) ?? "");
      const to = nodeIdMap.get(optStr(re.to) ?? "");
      if (!from || !to || from === to) continue;
      const id = newEdgeId();
      const oldEdgeId = optStr(re.id);
      if (oldEdgeId) edgeIdMap.set(oldEdgeId, id);
      const label = optStr(re.label);
      edges.push({ id, from, to, ...(label ? { label } : {}) });
    }

    const flows: CanvasFlow[] = (Array.isArray(data.flows) ? data.flows : [])
      .filter((f: any) => f && typeof f.name === "string" && Array.isArray(f.steps))
      .map((f: any) => ({
        id: optStr(f.id) ?? slugify(String(f.name)),
        name: String(f.name),
        steps: (f.steps as any[])
          .filter((s) => s && typeof s.nodeId === "string")
          .map((s) => {
            const nodeId = nodeIdMap.get(String(s.nodeId));
            if (!nodeId) return null;
            const edges = Array.isArray(s.edges)
              ? s.edges.map((e: unknown) => edgeIdMap.get(String(e))).filter((x): x is string => Boolean(x))
              : undefined;
            return {
              nodeId,
              caption: String(s.caption ?? ""),
              ...(edges && edges.length ? { edges } : {}),
            } as FlowStep;
          })
          .filter((s): s is FlowStep => Boolean(s)),
      }));

    const links = [...new Set(
      (Array.isArray(data.links) ? data.links : [])
        .map((x: unknown) => remapCanvas(x))
        .filter((x): x is string => Boolean(x) && x !== canvas.id),
    )];

    canvas.nodes = nodes;
    canvas.edges = edges;
    if (flows.length) canvas.flows = flows;
    else delete canvas.flows;
    if (links.length) canvas.links = links;
    else delete canvas.links;
    const remappedLayout = sanitizeDockLayout(data.layout, (oldId) => nodeIdMap.get(oldId));
    if (remappedLayout && (remappedLayout.root || remappedLayout.minimized?.length)) canvas.layout = remappedLayout;
    else delete canvas.layout;
    const parentCanvasId = remapCanvas(data.parentCanvasId);
    if (parentCanvasId && parentCanvasId !== canvas.id) canvas.parentCanvasId = parentCanvasId;
    else delete canvas.parentCanvasId;
    if (typeof data.createdAt === "string") canvas.createdAt = data.createdAt;
    save(canvas);
  }

  return shells.map(({ p, canvas }) => ({
    originalId: p.originalId,
    id: canvas.id,
    name: canvas.name,
  }));
}

export function findNode(nodeId: string): { canvas: Canvas; node: CanvasNode } {
  for (const canvas of canvases.values()) {
    const node = canvas.nodes.find((n) => n.id === nodeId);
    if (node) return { canvas, node };
  }
  throw new HttpError(404, `node "${nodeId}" not found`);
}

/** Place a new node to the right of the most recent one, wrapping into a new row. */
function autoPlace(c: Canvas, w: number): { x: number; y: number } {
  if (c.nodes.length === 0) return { x: 0, y: 0 };
  const last = c.nodes.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
  const x = last.x + last.w + GAP;
  if (x + w <= WRAP_X) return { x, y: last.y };
  const bottom = Math.max(...c.nodes.map((n) => n.y + n.h));
  return { x: 0, y: bottom + GAP * 1.5 };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined);

const optStr = (v: unknown) => (v !== undefined && v !== null && String(v).trim() !== "" ? String(v) : undefined);

const MAX_STATE_BYTES = 128 * 1024;

/** JSON-normalise an app state value and enforce a size cap. */
function normaliseState(value: unknown): unknown {
  let json: string;
  try {
    json = JSON.stringify(value ?? null);
  } catch {
    throw new HttpError(400, "state must be JSON-serialisable");
  }
  if (json.length > MAX_STATE_BYTES) {
    throw new HttpError(413, `state is ${Math.round(json.length / 1024)} KB, limit is ${MAX_STATE_BYTES / 1024} KB`);
  }
  return JSON.parse(json);
}

export function addNode(canvasId: string, input: Partial<CanvasNode> & { children?: string[] }): CanvasNode {
  const c = getCanvas(canvasId);
  const type = input.type as NodeType;
  if (!["html", "diagram", "note", "card", "group"].includes(type)) throw new HttpError(400, `invalid type "${type}"`);
  const size = DEFAULT_SIZE[type];

  // If creating a group with `children` and no explicit bounds, auto-fit padded bounds around them
  const childIds = type === "group" && Array.isArray(input.children) ? input.children.map(String) : [];
  const childNodes = childIds.length ? c.nodes.filter((n) => childIds.includes(n.id)) : [];
  let autoBox: { x: number; y: number; w: number; h: number } | null = null;
  if (childNodes.length) {
    const padX = 32, padTop = 74, padBottom = 32;
    const minX = Math.min(...childNodes.map((n) => n.x));
    const minY = Math.min(...childNodes.map((n) => n.y));
    const maxX = Math.max(...childNodes.map((n) => n.x + n.w));
    const maxY = Math.max(...childNodes.map((n) => n.y + n.h));
    autoBox = { x: minX - padX, y: minY - padTop, w: maxX - minX + padX * 2, h: maxY - minY + padTop + padBottom };
  }

  const w = num(input.w) ?? autoBox?.w ?? size.w;
  const h = num(input.h) ?? autoBox?.h ?? size.h;
  const pos = num(input.x) !== undefined && num(input.y) !== undefined
    ? { x: num(input.x)!, y: num(input.y)! }
    : autoBox
      ? { x: autoBox.x, y: autoBox.y }
      : autoPlace(c, w);

  const subtitle = optStr(input.subtitle);
  const group = optStr(input.group);
  const color = optStr(input.color);
  const meta = optStr(input.meta);
  const parentId = optStr(input.parentId);
  const subCanvasId = optStr(input.subCanvasId);
  const node: CanvasNode = {
    id: shortId(),
    type,
    title: String(input.title ?? (type === "note" ? "Note" : type === "card" ? "Node" : type === "group" ? "Subgraph" : "Untitled")),
    content: String(input.content ?? ""),
    ...(subtitle ? { subtitle } : {}),
    ...(group ? { group } : {}),
    ...(color ? { color } : {}),
    ...(meta ? { meta } : {}),
    ...(parentId ? { parentId } : {}),
    ...(type === "group" && input.collapsed ? { collapsed: true } : {}),
    ...(subCanvasId ? { subCanvasId } : {}),
    ...(input.state !== undefined && input.state !== null ? { state: normaliseState(input.state) } : {}),
    ...pos, w, h,
    author: input.author === "user" ? "user" : "agent",
    rev: 1,
    createdAt: now(),
    updatedAt: now(),
    history: [],
  };
  if (type === "group") c.nodes.unshift(node);
  else c.nodes.push(node);

  for (const ch of childNodes) {
    if (ch.id !== node.id) {
      ch.parentId = node.id;
      ch.updatedAt = now();
    }
  }
  save(c);
  return node;
}

export function updateNode(nodeId: string, patch: Partial<CanvasNode> & { children?: string[] }): { canvas: Canvas; node: CanvasNode } {
  const { canvas, node } = findNode(nodeId);
  const title = patch.title !== undefined ? String(patch.title) : node.title;
  const content = patch.content !== undefined ? String(patch.content) : node.content;
  let metaChanged = false;
  for (const k of ["subtitle", "group", "color", "meta", "parentId", "subCanvasId"] as const) {
    if (patch[k] !== undefined) {
      const next = optStr(patch[k]);
      if (next !== node[k]) {
        if (next && !(k === "parentId" && next === node.id)) node[k] = next;
        else delete node[k];
        metaChanged = true;
      }
    }
  }
  if (typeof patch.collapsed === "boolean" && patch.collapsed !== Boolean(node.collapsed)) {
    if (patch.collapsed) node.collapsed = true;
    else delete node.collapsed;
    metaChanged = true;
  }
  if (node.type === "group" && Array.isArray(patch.children)) {
    const wanted = new Set(patch.children.map(String));
    for (const n of canvas.nodes) {
      if (n.id === node.id) continue;
      if (wanted.has(n.id)) n.parentId = node.id;
      else if (n.parentId === node.id) delete n.parentId;
    }
  }
  if (title !== node.title || content !== node.content) {
    node.history.push({ title: node.title, content: node.content, at: node.updatedAt });
    if (node.history.length > MAX_HISTORY) node.history.shift();
    node.title = title;
    node.content = content;
    node.rev++;
  } else if (metaChanged) {
    node.rev++;
  }
  for (const k of ["x", "y"] as const) if (num(patch[k]) !== undefined) node[k] = num(patch[k])!;
  for (const k of ["w", "h"] as const) if (num(patch[k]) !== undefined) node[k] = Math.max(80, num(patch[k])!);
  if (patch.state !== undefined) {
    if (patch.state === null) delete node.state;
    else node.state = normaliseState(patch.state);
  }
  node.updatedAt = now();
  save(canvas);
  return { canvas, node };
}

/** Replace (or clear, with null) a node's live app state. Does not touch content/rev/history. */
export function setNodeState(nodeId: string, state: unknown): { canvas: Canvas; node: CanvasNode } {
  const { canvas, node } = findNode(nodeId);
  if (node.type !== "html") throw new HttpError(400, `node "${nodeId}" is a ${node.type}, not an interactive html app`);
  if (state === null || state === undefined) delete node.state;
  else node.state = normaliseState(state);
  node.updatedAt = now();
  save(canvas);
  return { canvas, node };
}

export function moveNodes(canvasId: string, moves: Array<{ id: string; x?: number; y?: number; w?: number; h?: number }>): Canvas {
  const c = getCanvas(canvasId);
  const byId = new Map(c.nodes.map((n) => [n.id, n]));
  const ts = now();
  for (const m of moves) {
    const n = byId.get(m.id);
    if (!n) continue;
    if (num(m.x) !== undefined) n.x = num(m.x)!;
    if (num(m.y) !== undefined) n.y = num(m.y)!;
    if (num(m.w) !== undefined) n.w = Math.max(80, num(m.w)!);
    if (num(m.h) !== undefined) n.h = Math.max(80, num(m.h)!);
    n.updatedAt = ts;
  }
  save(c);
  return c;
}

export function deleteNode(nodeId: string): Canvas {
  const { canvas } = findNode(nodeId);
  canvas.nodes = canvas.nodes.filter((n) => n.id !== nodeId);
  for (const n of canvas.nodes) {
    if (n.parentId === nodeId) delete n.parentId;
  }
  canvas.edges = canvas.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
  if (canvas.layout) {
    const validIds = new Set(canvas.nodes.map((n) => n.id));
    canvas.layout = sanitizeDockLayout(canvas.layout, (nid) => (validIds.has(nid) ? nid : undefined));
  }
  save(canvas);
  return canvas;
}

export function addEdge(from: string, to: string, label?: string): { canvas: Canvas; edge: Edge } {
  const a = findNode(from), b = findNode(to);
  if (a.canvas !== b.canvas) throw new HttpError(400, "nodes are on different canvases");
  const edge: Edge = { id: `e-${shortId()}`, from, to, ...(label ? { label: String(label) } : {}) };
  a.canvas.edges.push(edge);
  save(a.canvas);
  return { canvas: a.canvas, edge };
}

export function deleteEdge(edgeId: string): Canvas {
  for (const c of canvases.values()) {
    const i = c.edges.findIndex((e) => e.id === edgeId);
    if (i >= 0) { c.edges.splice(i, 1); save(c); return c; }
  }
  throw new HttpError(404, `edge "${edgeId}" not found`);
}
