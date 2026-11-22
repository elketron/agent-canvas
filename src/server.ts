// Canvas HTTP server: REST API + SSE live updates + static UI.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as store from "./store";
import * as eventLog from "./events";

const PORT = Number(process.env.CANVAS_PORT ?? 4477);
// Local-first by default: this server runs arbitrary user HTML and can read/write
// canvas folders, so it must not be reachable from the LAN unless explicitly asked.
const HOST = process.env.CANVAS_HOST ?? "127.0.0.1";
const ROOT = join(import.meta.dir, "..");
const PUBLIC = join(ROOT, "public");
const MERMAID_ESM = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs";
const BOOT_ID = crypto.randomUUID().slice(0, 8);

// ---- SSE -------------------------------------------------------------------
const enc = new TextEncoder();
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

export type Event =
  | { kind: "hello"; bootId: string }
  | { kind: "canvases" }
  | { kind: "canvas"; canvasId: string; action: "created" | "updated" | "deleted"; nodeId?: string; title?: string }
  | { kind: "focus"; canvasId: string; nodeId?: string }
  | { kind: "ui-state"; canvasId: string; nodeId: string; state: unknown }
  | { kind: "ui-event"; canvasId: string; nodeId: string; event: eventLog.UiEvent };

function broadcast(ev: Event) {
  const chunk = enc.encode(`data: ${JSON.stringify(ev)}\n\n`);
  for (const c of clients) {
    try { c.enqueue(chunk); } catch { clients.delete(c); }
  }
}
setInterval(() => {
  const ping = enc.encode(": ping\n\n");
  for (const c of clients) { try { c.enqueue(ping); } catch { clients.delete(c); } }
}, 20_000);

function events(req: Request) {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      clients.add(c);
      c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "hello", bootId: BOOT_ID })}\n\n`));
    },
    cancel() { clients.delete(ctrl); },
  });
  req.signal.addEventListener("abort", () => clients.delete(ctrl));
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

// ---- helpers ---------------------------------------------------------------
const json = (data: unknown, status = 200) => Response.json(data, { status });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const body = async (req: Request) => { try { return await req.json(); } catch { return {}; } };

// ---- portable canvas folders ------------------------------------------------
function resolveFolder(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) throw new store.HttpError(400, "folder is required");
  let p = input.trim();
  if (p === "~") p = homedir();
  else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  return resolve(ROOT, p);
}

function bundleFileName(id: string) {
  const safe = id.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return `${safe || "canvas"}.canvas.json`;
}

function saveToFolder(folderInput: unknown, canvasIds: unknown) {
  const folder = resolveFolder(folderInput);
  mkdirSync(folder, { recursive: true });
  const ids = Array.isArray(canvasIds) && canvasIds.length
    ? [...new Set(canvasIds.map(String))]
    : store.listCanvases().map((c) => c.id);
  const saved: Array<{ id: string; name: string; file: string }> = [];
  for (const id of ids) {
    const canvas = store.getCanvas(id);
    const file = join(folder, bundleFileName(canvas.id));
    const bundle = { format: "agent-canvas", version: 1, exportedAt: new Date().toISOString(), canvas };
    writeFileSync(file, JSON.stringify(bundle, null, 2));
    saved.push({ id: canvas.id, name: canvas.name, file });
  }
  return { folder, saved };
}

function loadFromFolder(folderInput: unknown, namePrefix: unknown) {
  const folder = resolveFolder(folderInput);
  let files: string[];
  try {
    files = readdirSync(folder).filter((f) => f.toLowerCase().endsWith(".canvas.json")).sort();
  } catch {
    throw new store.HttpError(400, `folder not found or unreadable: ${folder}`);
  }
  if (!files.length) throw new store.HttpError(400, `no .canvas.json files in ${folder}`);

  const snapshots: any[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(folder, file), "utf8"));
      const canvas = raw && typeof raw === "object" && raw.format === "agent-canvas" ? raw.canvas : raw;
      if (!canvas || typeof canvas !== "object" || !Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges)) {
        throw new Error("not an Agent Canvas file");
      }
      snapshots.push(canvas);
    } catch (e) {
      errors.push({ file, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (!snapshots.length) throw new store.HttpError(400, `no valid canvas files in ${folder}`);
  const imported = store.importCanvasSnapshots(snapshots, typeof namePrefix === "string" ? namePrefix : "");
  return { folder, imported, errors };
}

const FONT_LINK = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">`;

const RUNTIME_FILE = join(PUBLIC, "canvas-runtime.js");
const THEME = {
  bg: "#0e0e0f", bgDeep: "#0a0a0b", panel: "#111112", panel2: "#131315",
  surface: "#171718", surface2: "#1a1a1c", border: "#222224", border2: "#2a2a2c",
  fg: "#c2c0b6", fgBright: "#d8d6cc", fgDim: "#8a8880", fgFaint: "#6a6865",
  accent: "#4e46a0", accentHi: "#5e56b0", accentSoft: "#8a82cc",
  accentDeep: "#12111a", accentBorder: "#2a2740",
  ok: "#4CAF82", warn: "#d4a843", err: "#e05a5a",
  font: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
};

/** Inject the canvas runtime (and this node's identity/state) into an HTML app. */
function injectRuntime(html: string, node: store.CanvasNode, canvasId: string): string {
  const prelude = JSON.stringify({ nodeId: node.id, canvasId, title: node.title, state: node.state ?? null, theme: THEME })
    .replace(/</g, "\\u003c");
  const runtime = readFileSync(RUNTIME_FILE, "utf8").replace(/<\/script/gi, "<\\/script");
  const tag = `<script>window.__canvasHost=${prelude}</script>\n<script>\n${runtime}\n</script>`;
  const head = html.match(/<head[^>]*>/i);
  if (head) return html.replace(head[0], `${head[0]}\n${tag}`);
  const doctype = html.match(/<!doctype[^>]*>/i);
  if (doctype) return html.replace(doctype[0], `${doctype[0]}\n${tag}`);
  return `${tag}\n${html}`;
}

function renderStandalone(node: store.CanvasNode, canvasId: string): Response {
  let html: string;
  if (node.type === "html") {
    html = injectRuntime(node.content, node, canvasId);
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  } else if (node.type === "diagram") {
    html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(node.title)}</title>${FONT_LINK}</head>
<body style="margin:0;background:#0e0e0f;min-height:100vh;display:grid;place-items:center">
<pre class="mermaid">${esc(node.content)}</pre>
<script type="module">import m from "${MERMAID_ESM}";import { MERMAID_THEME } from "/mermaid-theme.js";m.initialize({startOnLoad:false,theme:"base",securityLevel:"strict",fontFamily:MERMAID_THEME.fontFamily,themeVariables:MERMAID_THEME});await m.run({querySelector:".mermaid"});</script>
</body></html>`;
  } else if (node.type === "card" || node.type === "group") {
    html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(node.title)}</title>${FONT_LINK}</head>
<body style="font:15px/1.6 &quot;JetBrains Mono&quot;,ui-monospace,monospace;background:#0e0e0f;color:#c2c0b6;max-width:760px;margin:40px auto;padding:0 20px">
${node.group ? `<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:${esc(node.color ?? "#8a82cc")}">${esc(node.group)}${node.meta ? ` · ${esc(node.meta)}` : ""}</div>` : ""}
<h1 style="margin:6px 0">${esc(node.title)}</h1>
${node.subtitle ? `<p style="color:#8a8880;margin-top:0">${esc(node.subtitle)}</p>` : ""}
<pre style="white-space:pre-wrap;background:#171718;padding:16px;border-radius:10px;border:1px solid #222224">${esc(node.content)}</pre>
</body></html>`;
  } else {
    html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(node.title)}</title>${FONT_LINK}</head>
<body style="font:15px/1.5 &quot;JetBrains Mono&quot;,ui-monospace,monospace;background:#0e0e0f;color:#c2c0b6;max-width:720px;margin:40px auto;padding:0 16px"><h1>${esc(node.title)}</h1><pre style="white-space:pre-wrap">${esc(node.content)}</pre></body></html>`;
  }
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

// ---- router ----------------------------------------------------------------
async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const m = req.method;

  if (p[0] !== "api") {
    const file = Bun.file(join(PUBLIC, p.length ? p.join("/") : "index.html"));
    if (!file.name!.startsWith(PUBLIC) || !(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file, { headers: { "cache-control": "no-store" } });
  }

  // /api/events
  if (p[1] === "events" && m === "GET") return events(req);

  // /api/folders/save | /api/folders/load — portable .canvas.json folders
  if (p[1] === "folders") {
    if (p[2] === "save" && m === "POST") {
      const { folder, canvasIds } = await body(req);
      return json(saveToFolder(folder, canvasIds));
    }
    if (p[2] === "load" && m === "POST") {
      const { folder, namePrefix } = await body(req);
      const result = loadFromFolder(folder, namePrefix);
      broadcast({ kind: "canvases" });
      return json(result);
    }
  }

  // /api/ui-events — the log of user actions inside interactive apps
  if (p[1] === "ui-events" && m === "GET") {
    const q = url.searchParams;
    return json(eventLog.listEvents({
      canvasId: q.get("canvas") || undefined,
      nodeId: q.get("node") || undefined,
      since: q.get("since") ? Number(q.get("since")) : undefined,
      limit: q.get("limit") ? Number(q.get("limit")) : undefined,
      clear: q.get("clear") === "1",
    }));
  }

  // /api/canvases[...]
  if (p[1] === "canvases") {
    if (p.length === 2) {
      if (m === "GET") return json(store.listCanvases());
      if (m === "POST") {
        const { name, mode, parentCanvasId } = await body(req);
        const c = store.createCanvas(String(name || "Untitled"), mode, parentCanvasId);
        broadcast({ kind: "canvases" });
        return json(c, 201);
      }
    }
    const cid = p[2];
    if (p.length === 3) {
      if (m === "GET") {
        const existed = store.listCanvases().some((c) => c.id === cid);
        const c = store.getCanvas(cid);
        if (!existed) broadcast({ kind: "canvases" });
        return json(c);
      }
      if (m === "PATCH") {
        const c = store.updateCanvas(cid, await body(req));
        broadcast({ kind: "canvas", canvasId: cid, action: "updated" });
        broadcast({ kind: "canvases" });
        return json(c);
      }
      if (m === "DELETE") {
        const affected = store.deleteCanvas(cid);
        for (const id of affected) broadcast({ kind: "canvas", canvasId: id, action: "updated" });
        broadcast({ kind: "canvases" });
        return json({ ok: true });
      }
    }

    // /api/canvases/:id/links[/:to] — related canvases (symmetric)
    if (p[3] === "links") {
      if (m === "POST") {
        const { to } = await body(req);
        if (typeof to !== "string" || !to.trim()) return json({ error: 'field "to" is required' }, 400);
        const { canvas, linked } = store.linkCanvases(cid, to, true);
        broadcast({ kind: "canvas", canvasId: canvas.id, action: "updated" });
        broadcast({ kind: "canvas", canvasId: linked.id, action: "updated" });
        broadcast({ kind: "canvases" });
        return json({ canvas, linked });
      }
      if (p[4] && m === "DELETE") {
        const { canvas, linked } = store.linkCanvases(cid, p[4], false);
        broadcast({ kind: "canvas", canvasId: canvas.id, action: "updated" });
        broadcast({ kind: "canvas", canvasId: linked.id, action: "updated" });
        broadcast({ kind: "canvases" });
        return json({ canvas, linked });
      }
    }

    if (p[3] === "nodes" && m === "POST") {
      const node = store.addNode(cid, await body(req));
      broadcast({ kind: "canvas", canvasId: cid, action: "created", nodeId: node.id, title: node.title });
      broadcast({ kind: "canvases" });
      return json(node, 201);
    }
    if (p[3] === "positions" && m === "PATCH") {
      const { moves } = await body(req);
      const c = store.moveNodes(cid, Array.isArray(moves) ? moves : []);
      broadcast({ kind: "canvas", canvasId: cid, action: "updated" });
      return json(c);
    }
    if (p[3] === "edges" && m === "POST") {
      const { from, to, label } = await body(req);
      const { canvas, edge } = store.addEdge(from, to, label);
      broadcast({ kind: "canvas", canvasId: canvas.id, action: "updated" });
      return json(edge, 201);
    }
    if (p[3] === "focus" && m === "POST") {
      store.getCanvas(cid);
      const { nodeId } = await body(req);
      broadcast({ kind: "focus", canvasId: cid, nodeId });
      return json({ ok: true, viewers: clients.size });
    }
  }

  // /api/nodes/:id[/render|/app|/state|/events]
  if (p[1] === "nodes" && p[2]) {
    const nid = p[2];
    if ((p[3] === "render" || p[3] === "app") && m === "GET") {
      const { canvas, node } = store.findNode(nid);
      return renderStandalone(node, canvas.id);
    }
    if (p[3] === "state") {
      const { canvas, node } = store.findNode(nid);
      if (m === "GET") return json({ nodeId: node.id, state: node.state ?? null });
      if (m === "PUT" || m === "PATCH") {
        const { state } = await body(req);
        const { node: updated } = store.setNodeState(nid, state ?? null);
        broadcast({ kind: "ui-state", canvasId: canvas.id, nodeId: node.id, state: updated.state ?? null });
        return json({ nodeId: node.id, state: updated.state ?? null });
      }
    }
    if (p[3] === "events") {
      const { canvas, node } = store.findNode(nid);
      if (m === "POST") {
        const { type, payload } = await body(req);
        const ev = eventLog.recordEvent(canvas.id, node.id, type, payload);
        broadcast({ kind: "ui-event", canvasId: canvas.id, nodeId: node.id, event: ev });
        return json(ev, 201);
      }
      if (m === "GET") {
        return json(eventLog.listEvents({
          nodeId: node.id,
          since: url.searchParams.get("since") ? Number(url.searchParams.get("since")) : undefined,
          limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
          clear: url.searchParams.get("clear") === "1",
        }));
      }
    }
    if (p.length === 3) {
      if (m === "GET") { const { canvas, node } = store.findNode(nid); return json({ ...node, canvasId: canvas.id }); }
      if (m === "PATCH") {
        const patch = await body(req);
        const { canvas, node } = store.updateNode(nid, patch);
        broadcast({ kind: "canvas", canvasId: canvas.id, action: "updated", nodeId: node.id, title: node.title });
        if (patch.state !== undefined) {
          broadcast({ kind: "ui-state", canvasId: canvas.id, nodeId: node.id, state: node.state ?? null });
        }
        return json({ ...node, canvasId: canvas.id });
      }
      if (m === "DELETE") {
        const canvas = store.deleteNode(nid);
        eventLog.removeNodeEvents(nid);
        broadcast({ kind: "canvas", canvasId: canvas.id, action: "deleted", nodeId: nid });
        broadcast({ kind: "canvases" });
        return json({ ok: true });
      }
    }
  }

  // /api/edges/:id
  if (p[1] === "edges" && p[2] && m === "DELETE") {
    const canvas = store.deleteEdge(p[2]);
    broadcast({ kind: "canvas", canvasId: canvas.id, action: "updated" });
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}

Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 0, // keep SSE connections open
  async fetch(req) {
    try {
      return await route(req);
    } catch (e) {
      if (e instanceof store.HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: String(e) }, 500);
    }
  },
});

console.log(`Agent Canvas running at http://${HOST}:${PORT}  (data: ${store.DATA_DIR})`);
