// Minimal stdio MCP server (JSON-RPC 2.0, newline-delimited) that lets an agent draw on the canvas.
// It talks to the canvas HTTP server and starts it in the background if it isn't running.
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { captureScreenshot } from "./screenshot";

const PORT = Number(process.env.CANVAS_PORT ?? 4477);
const BASE = process.env.CANVAS_URL ?? `http://localhost:${PORT}`;
const ROOT = join(import.meta.dir, "..");

const log = (...a: unknown[]) => console.error("[canvas-mcp]", ...a); // stdout is reserved for protocol

// ---- canvas server lifecycle -------------------------------------------------
async function isUp() {
  try { return (await fetch(`${BASE}/api/canvases`, { signal: AbortSignal.timeout(800) })).ok; } catch { return false; }
}
let starting: Promise<void> | null = null;
function ensureServer(): Promise<void> {
  return (starting ??= (async () => {
    if (await isUp()) return;
    if (process.env.CANVAS_URL) throw new Error(`canvas server not reachable at ${BASE}`);
    mkdirSync(join(ROOT, "data"), { recursive: true });
    const out = openSync(join(ROOT, "data", "server.log"), "a");
    const child = spawn(process.execPath, [join(import.meta.dir, "server.ts")], {
      detached: true, stdio: ["ignore", out, out], env: process.env, cwd: ROOT,
    });
    child.unref();
    for (let i = 0; i < 60; i++) {
      await Bun.sleep(100);
      if (await isUp()) { log(`started canvas server at ${BASE}`); return; }
    }
    throw new Error(`could not start canvas server (see ${join(ROOT, "data", "server.log")})`);
  })().catch((e) => { starting = null; throw e; }));
}

/** The server stopped since it was last seen up: forget that, so the next call starts it again. */
function serverGone() {
  starting = null;
}

async function request(method: string, path: string, payload?: unknown) {
  return fetch(BASE + path, {
    method,
    headers: payload ? { "content-type": "application/json" } : {},
    body: payload ? JSON.stringify(payload) : undefined,
  });
}

async function api(method: string, path: string, payload?: unknown) {
  await ensureServer();
  let res: Response;
  try {
    res = await request(method, path, payload);
  } catch {
    // Connection refused: the server died (or was stopped) after it was started. Start it again once.
    serverGone();
    await ensureServer();
    res = await request(method, path, payload);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}

const viewUrl = (canvas: string, node?: string) =>
  `${BASE}/?canvas=${encodeURIComponent(canvas)}${node ? `#node=${node}` : ""}`;

// ---- tools -----------------------------------------------------------------
type Args = Record<string, any>;
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  run: (a: Args) => Promise<string | ContentBlock[]>;
}

const geom = {
  x: { type: "number", description: "Left position in canvas px. Omit to auto-place next to the previous item." },
  y: { type: "number", description: "Top position in canvas px. Omit to auto-place." },
  width: { type: "number" },
  height: { type: "number" },
};
const canvasProp = { canvas: { type: "string", description: 'Canvas id (default "main"). Use list_canvases to see ids.' } };

/** Keep get_canvas readable when a UI carries a lot of state. */
function previewState(state: unknown) {
  const json = JSON.stringify(state);
  return json.length > 500 ? `${json.slice(0, 500)}… (${json.length} chars)` : state;
}

async function create(type: string, a: Args, content: string, title: string, extra?: Record<string, unknown>) {
  const canvas = a.canvas || "main";
  const n = await api("POST", `/api/canvases/${encodeURIComponent(canvas)}/nodes`, {
    type, title, content, x: a.x, y: a.y, w: a.width, h: a.height, author: "agent", ...extra,
  });
  return `Created ${type} "${n.title}" id=${n.id} on canvas "${canvas}" at (${n.x}, ${n.y}) size ${n.w}x${n.h}.\nView: ${viewUrl(canvas, n.id)}`;
}

const tools: Tool[] = [
  {
    name: "list_canvases",
    description: "List all canvases (separate boards/pages), with mode, node counts and related-canvas links.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const list = await api("GET", "/api/canvases");
      if (!list.length) return `No canvases yet. Creating anything targets "main". UI: ${BASE}`;
      return list.map((c: any) => {
        const related = Array.isArray(c.links) && c.links.length ? `, related: ${c.links.join(", ")}` : "";
        return `- ${c.id} ("${c.name}", mode=${c.mode ?? "board"}) — ${c.nodes} items, updated ${c.updatedAt}${related}`;
      }).join("\n") + `\nUI: ${BASE}`;
    },
  },
  {
    name: "create_canvas",
    description: 'Create a new canvas, e.g. one per project or topic. Set mode="ui" for a non-infinite workspace with dockable boards (best for interactive apps), mode="diagram" for interactive click-through node graphs, or "board" (default) for infinite mockups/notes. Set parent_canvas_id when creating a drill-down subgraph canvas.',
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        mode: { type: "string", enum: ["board", "diagram", "ui"], description: 'Canvas interaction mode ("board", "diagram", or "ui")' },
        parent_canvas_id: { type: "string", description: "Optional parent canvas id for breadcrumb navigation when drilling into a subgraph." },
      },
      required: ["name"],
    },
    run: async (a) => {
      const c = await api("POST", "/api/canvases", { name: a.name, mode: a.mode, parentCanvasId: a.parent_canvas_id });
      return `Created canvas id="${c.id}" mode="${c.mode ?? "board"}". View: ${viewUrl(c.id)}`;
    },
  },
  {
    name: "set_canvas_mode",
    description:
      'Switch a canvas between "board", "diagram", and "ui" mode (non-infinite dockable workspace), and optionally define guided walkthrough `flows` (sequences of node_ids with captions that users can step through in Diagram mode).',
    inputSchema: {
      type: "object",
      properties: {
        ...canvasProp,
        mode: { type: "string", enum: ["board", "diagram", "ui"] },
        flows: {
          type: "array",
          description: "Optional interactive walkthrough flows across nodes in Diagram mode.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              steps: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    node_id: { type: "string" },
                    caption: { type: "string" },
                    edges: { type: "array", items: { type: "string" } },
                  },
                  required: ["node_id", "caption"],
                },
              },
            },
            required: ["name", "steps"],
          },
        },
      },
    },
    run: async (a) => {
      const canvas = a.canvas || "main";
      const flows = Array.isArray(a.flows)
        ? a.flows.map((f: any) => ({
            name: f.name,
            steps: (f.steps ?? []).map((s: any) => ({
              nodeId: s.node_id ?? s.nodeId,
              caption: s.caption ?? "",
              ...(Array.isArray(s.edges) ? { edges: s.edges } : {}),
            })),
          }))
        : undefined;
      const c = await api("PATCH", `/api/canvases/${encodeURIComponent(canvas)}`, { mode: a.mode, flows });
      return `Updated canvas "${c.id}" (mode=${c.mode ?? "board"}, flows=${c.flows?.length ?? 0}). View: ${viewUrl(c.id)}`;
    },
  },
  {
    name: "get_canvas",
    description:
      "Read a canvas: mode, flows, every item's id, type, title, author, position/size and a short content preview, plus arrows. " +
      'Items with author "user" were added by the human — treat their notes as feedback/requests. Use get_node for full content.',
    inputSchema: { type: "object", properties: { ...canvasProp } },
    run: async (a) => {
      const canvas = a.canvas || "main";
      const c = await api("GET", `/api/canvases/${encodeURIComponent(canvas)}`);
      const nodes = c.nodes.map((n: any) => ({
        id: n.id, type: n.type, title: n.title,
        ...(n.group ? { group: n.group } : {}),
        ...(n.subtitle ? { subtitle: n.subtitle } : {}),
        ...(n.meta ? { meta: n.meta } : {}),
        ...(n.parentId ? { parentId: n.parentId } : {}),
        ...(n.collapsed ? { collapsed: true } : {}),
        ...(n.subCanvasId ? { subCanvasId: n.subCanvasId } : {}),
        author: n.author,
        ...(n.state !== undefined ? { state: previewState(n.state) } : {}),
        x: n.x, y: n.y, w: n.w, h: n.h, versions: n.history.length + 1,
        preview: n.content.length > 240 ? n.content.slice(0, 240) + "…" : n.content,
      }));
      return JSON.stringify({
        id: c.id, name: c.name, mode: c.mode ?? "board",
        ...(c.parentCanvasId ? { parentCanvasId: c.parentCanvasId } : {}),
        flows: c.flows ?? [], links: c.links ?? [], url: viewUrl(c.id), nodes, edges: c.edges,
      }, null, 2);
    },
  },
  {
    name: "link_canvases",
    description:
      "Link two canvases as related. Links are symmetric and idempotent; related canvases appear in a dock in the UI " +
      "and can be opened from there. Use this to keep satellite canvases discoverable without forcing a parent/child hierarchy.",
    inputSchema: {
      type: "object",
      properties: {
        canvas: { type: "string", description: 'First canvas id (default "main").' },
        linked_canvas: { type: "string", description: "The other canvas id to relate it to." },
      },
      required: ["linked_canvas"],
    },
    run: async (a) => {
      const cid = a.canvas || "main";
      const r = await api("POST", `/api/canvases/${encodeURIComponent(cid)}/links`, { to: a.linked_canvas });
      return `Linked "${r.canvas.name}" (${r.canvas.id}) ↔ "${r.linked.name}" (${r.linked.id}).`;
    },
  },
  {
    name: "unlink_canvases",
    description: "Remove a related-canvas link (symmetric, like link_canvases).",
    inputSchema: {
      type: "object",
      properties: {
        canvas: { type: "string", description: 'First canvas id (default "main").' },
        linked_canvas: { type: "string", description: "The other canvas id to unlink." },
      },
      required: ["linked_canvas"],
    },
    run: async (a) => {
      const cid = a.canvas || "main";
      const r = await api("DELETE", `/api/canvases/${encodeURIComponent(cid)}/links/${encodeURIComponent(a.linked_canvas)}`);
      return `Unlinked "${r.canvas.name}" (${r.canvas.id}) ↔ "${r.linked.name}" (${r.linked.id}).`;
    },
  },
  {
    name: "save_canvases_to_folder",
    description:
      "Save canvases to a folder as portable .canvas.json files. Omit canvas_ids to save every canvas. " +
      "Include any linked or drill-down canvases you want to keep connected after import; references to canvases " +
      "not present in the folder are dropped on import. Relative paths resolve against the project root; ~ is expanded.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Destination folder, e.g. ~/canvas-backups/q4 or /tmp/design-snapshot. Created if missing." },
        canvas_ids: { type: "array", items: { type: "string" }, description: "Canvas ids to save. Omit to save every canvas." },
      },
      required: ["folder"],
    },
    run: async (a) => {
      const r = await api("POST", "/api/folders/save", { folder: a.folder, canvasIds: a.canvas_ids });
      if (!r.saved.length) return `No canvases saved to ${r.folder}.`;
      return `Saved ${r.saved.length} canvas(es) to ${r.folder}:\n` +
        r.saved.map((s: any) => `- ${s.id} ("${s.name}") → ${s.file}`).join("\n");
    },
  },
  {
    name: "load_canvases_from_folder",
    description:
      "Import every .canvas.json file from a folder as new canvases. Canvas, node and edge ids are remapped, so this " +
      "never overwrites existing canvases. Internal links, parent canvases, drill-down sub-canvases, edges and flows " +
      "are preserved when all referenced canvases are in the folder.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder containing .canvas.json files. Relative paths resolve against the project root; ~ is expanded." },
        name_prefix: { type: "string", description: "Optional prefix added to imported canvas names." },
      },
      required: ["folder"],
    },
    run: async (a) => {
      const r = await api("POST", "/api/folders/load", { folder: a.folder, namePrefix: a.name_prefix });
      let out = `Imported ${r.imported.length} canvas(es) from ${r.folder}:\n` +
        r.imported.map((c: any) => `- "${c.name}" id=${c.id} (was ${c.originalId}) → ${viewUrl(c.id)}`).join("\n");
      if (r.errors?.length) {
        out += `\nSkipped ${r.errors.length} file(s):\n` + r.errors.map((e: any) => `- ${e.file}: ${e.error}`).join("\n");
      }
      return out;
    },
  },
  {
    name: "create_html_board",
    description:
      "Draw a UI mockup as a board: a complete HTML document rendered live in a sandboxed iframe (scripts allowed). " +
      'CDN scripts work, e.g. <script src="https://cdn.tailwindcss.com"></script>. Size the board to the viewport you design ' +
      "for (default 960x640; e.g. 390x844 for mobile, 1280x800 for desktop). Include all CSS/JS inline.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, html: { type: "string" }, ...canvasProp, ...geom },
      required: ["title", "html"],
    },
    run: (a) => create("html", a, a.html, a.title),
  },
  {
    name: "create_ui",
    description:
      "Create an INTERACTIVE app card: real HTML+JS that runs live on the canvas and can talk back to the agent. " +
      "Inside the app, use the injected `window.canvas` API:\n" +
      "  canvas.state.get() / canvas.state.set(v) / canvas.state.update(patch) — persistent JSON, survives reloads and content edits\n" +
      "  canvas.emit(type, payload) — record a user action the agent can read later with get_ui_events\n" +
      "  canvas.on('state', fn) — react when the agent pushes new state (via set_ui_state)\n" +
      "  canvas.notify(text), canvas.setTitle(text), canvas.resize({height, width}), canvas.open(nodeIdOrCanvasId), canvas.focus(nodeId)\n" +
      "  canvas.theme — the canvas palette (bg/fg/border/accent/ok/warn/err…); canvas.node {id, title}\n" +
      "Scripts run in a sandboxed iframe: no cookies/localStorage, so persist with canvas.state. Useful for settings panels, " +
      "calculators, filters, JSON/regex tools, decision/approval gates and dashboards whose 'submit' emits an event. " +
      "For a plain non-interactive mockup use create_html_board instead.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        html: { type: "string", description: "Complete HTML document. Add <meta name=color-scheme content=dark> and style it with canvas.theme or your own CSS." },
        state: { type: "object", description: "Optional initial JSON state." },
        ...canvasProp,
        ...geom,
      },
      required: ["title", "html"],
    },
    run: (a) => create(
      "html",
      { ...a, width: a.width ?? 520, height: a.height ?? 660 },
      a.html,
      a.title,
      a.state !== undefined ? { state: a.state } : undefined,
    ),
  },
  {
    name: "create_diagram",
    description:
      "Draw a diagram from Mermaid source (flowchart, sequenceDiagram, classDiagram, erDiagram, stateDiagram-v2, C4Context, " +
      "architecture-beta, gantt, mindmap, …). Good for architecture, data flow, and component relationships. Do not wrap in ``` fences.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, mermaid: { type: "string" }, ...canvasProp, ...geom },
      required: ["title", "mermaid"],
    },
    run: (a) => create("diagram", a, a.mermaid.replace(/^```(?:mermaid)?\s*|\s*```\s*$/g, ""), a.title),
  },
  {
    name: "create_card",
    description:
      "Create a compact interactive diagram node card (best used on a mode='diagram' canvas with `connect` arrows between cards). " +
      "Clicking the card on the canvas spotlights its connected edges/neighbors and opens `details` (Markdown + code snippets) in the Inspector Drawer.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Node title, e.g. file path or service name" },
        subtitle: { type: "string", description: "Short 1-line role shown on the card" },
        group: { type: "string", description: 'Layer/category pill, e.g. "MCP", "Server", "UI", "Storage"' },
        color: { type: "string", description: 'Hex accent color, e.g. "#60a5fa", "#a78bfa", "#34d399", "#fb7185", "#fbbf24"' },
        meta: { type: "string", description: 'Compact monospace metadata, e.g. "163 LOC" or "Port 4477"' },
        details: { type: "string", description: "Full Markdown explanation, symbols, and code snippets shown in the Inspector Drawer" },
        parent_id: { type: "string", description: "Optional parent group node id to place this card inside a subgraph container." },
        sub_canvas_id: { type: "string", description: "Optional drill-down child canvas id (adds a Dive-In button to open the deeper subgraph)." },
        ...canvasProp,
        ...geom,
      },
      required: ["title"],
    },
    run: (a) => create("card", a, a.details ?? "", a.title, {
      subtitle: a.subtitle, group: a.group, color: a.color, meta: a.meta,
      parentId: a.parent_id, subCanvasId: a.sub_canvas_id,
    }),
  },
  {
    name: "create_group",
    description:
      "Create a collapsible subgraph container on the canvas (best in mode='diagram'). Pass `children` (array of node ids) to group them and auto-fit padded bounds around them! " +
      "Dragging the group moves its children together; collapsing hides children and reroutes external arrows to the group. Optionally set `sub_canvas_id` for drill-down into a dedicated subgraph canvas.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Subgraph title, e.g. 'Backend Server & Storage'" },
        subtitle: { type: "string", description: "Short summary shown in header / collapsed state" },
        color: { type: "string", description: 'Hex accent color, e.g. "#60a5fa", "#a78bfa", "#34d399", "#fb7185"' },
        meta: { type: "string", description: "Optional compact metadata tag" },
        details: { type: "string", description: "Markdown description shown in Inspector Drawer when clicked" },
        children: { type: "array", items: { type: "string" }, description: "Node ids to assign into this subgraph (also auto-sizes the container if x/y/width/height omitted)" },
        parent_id: { type: "string", description: "Optional outer group node id for nested subgraphs" },
        collapsed: { type: "boolean", description: "Start collapsed into a compact summary node" },
        sub_canvas_id: { type: "string", description: "Optional drill-down canvas id for diving deeper into this subgraph" },
        ...canvasProp,
        ...geom,
      },
      required: ["title"],
    },
    run: (a) => create("group", a, a.details ?? "", a.title, {
      subtitle: a.subtitle, color: a.color, meta: a.meta, children: a.children,
      parentId: a.parent_id, collapsed: a.collapsed, subCanvasId: a.sub_canvas_id,
    }),
  },
  {
    name: "create_note",
    description: "Add a markdown sticky note — annotations, decisions, open questions, explanations next to boards.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Markdown" }, title: { type: "string" }, ...canvasProp, ...geom },
      required: ["text"],
    },
    run: (a) => create("note", a, a.text, a.title ?? "Note"),
  },
  {
    name: "get_node",
    description: "Get one item's full content (HTML / Mermaid / markdown) and metadata, including how many previous versions exist.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, node_id: { type: "string", description: "Alias for id" } } },
    run: async (a) => {
      const id = a.id ?? a.node_id;
      if (!id) throw new Error("id (or node_id) is required");
      const n = await api("GET", `/api/nodes/${encodeURIComponent(id)}`);
      const { history, content, ...meta } = n;
      return `${JSON.stringify({ ...meta, versions: history.length + 1 })}\n--- content ---\n${content}`;
    },
  },
  {
    name: "update_node",
    description:
      "Change an item. Either pass full `content`, or `edits` (exact find/replace pairs applied in order — cheaper for small " +
      "changes to big HTML). Also moves/resizes/renames. Previous content is kept as a version the user can restore.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        node_id: { type: "string", description: "Alias for id" },
        title: { type: "string" },
        subtitle: { type: "string" },
        group: { type: "string" },
        color: { type: "string" },
        meta: { type: "string" },
        parent_id: { type: "string", description: "Assign/change parent group id (pass empty string to ungroup)" },
        collapsed: { type: "boolean", description: "Collapse or expand a group subgraph" },
        sub_canvas_id: { type: "string", description: "Link/unlink a drill-down child canvas id" },
        children: { type: "array", items: { type: "string" }, description: "For group nodes: replace member child node ids" },
        content: { type: "string", description: "Full replacement content" },
        edits: {
          type: "array",
          items: { type: "object", properties: { find: { type: "string" }, replace: { type: "string" } }, required: ["find", "replace"] },
        },
        ...geom,
      },
    },
    run: async (a) => {
      const id = encodeURIComponent(a.id ?? a.node_id);
      if (!a.id && !a.node_id) throw new Error("id (or node_id) is required");
      let content: string | undefined = a.content;
      if (a.edits?.length) {
        content ??= (await api("GET", `/api/nodes/${id}`)).content as string;
        for (const [i, e] of a.edits.entries()) {
          const at = content!.indexOf(e.find);
          if (at < 0) throw new Error(`edit #${i + 1}: "find" text not found; nothing was changed`);
          content = content!.slice(0, at) + e.replace + content!.slice(at + e.find.length);
        }
      }
      const n = await api("PATCH", `/api/nodes/${id}`, {
        title: a.title, subtitle: a.subtitle, group: a.group, color: a.color, meta: a.meta,
        parentId: a.parent_id, collapsed: a.collapsed, subCanvasId: a.sub_canvas_id, children: a.children,
        content, x: a.x, y: a.y, w: a.width, h: a.height,
      });
      return `Updated "${n.title}" (id=${n.id}, version ${n.history.length + 1}) at (${n.x}, ${n.y}) size ${n.w}x${n.h}.`;
    },
  },
  {
    name: "set_ui_state",
    description:
      "Push new state into a live HTML app/UI node (created with create_ui). The running app receives it immediately via " +
      "canvas.on('state', …) and it is stored with the node. Use `merge: true` to shallow-merge into the existing object, " +
      "or omit it to replace the whole state. Pass state: null to clear.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string" },
        id: { type: "string", description: "Alias for node_id" },
        state: { description: "Any JSON value (object, array, string…). null clears it." },
        merge: { type: "boolean", description: "Shallow-merge into the current object state instead of replacing." },
      },
    },
    run: async (a) => {
      const id = encodeURIComponent(a.node_id ?? a.id);
      if (!a.node_id && !a.id) throw new Error("node_id (or id) is required");
      let state = a.state ?? null;
      if (a.merge && state && typeof state === "object" && !Array.isArray(state)) {
        const cur = (await api("GET", `/api/nodes/${id}`)).state;
        state = { ...(cur && typeof cur === "object" && !Array.isArray(cur) ? cur : {}), ...state };
      }
      const n = await api("PATCH", `/api/nodes/${id}`, { state });
      const size = JSON.stringify(n.state ?? null).length;
      return `Set state on "${n.title}" (${n.id}) — ${size} bytes. View: ${viewUrl(n.canvasId, n.id)}`;
    },
  },
  {
    name: "get_ui_events",
    description:
      "Read the actions people took inside interactive canvas UIs (canvas.emit from create_ui apps), oldest first: " +
      "type, payload, node and timestamp. This is how you learn what the user clicked, typed or submitted — e.g. 'user " +
      "chose plan=pro seats=25'. Filter by canvas or node; `since` returns only events newer than that event id; " +
      "`clear: true` consumes the returned events so they aren't read twice.",
    inputSchema: {
      type: "object",
      properties: {
        canvas: { type: "string", description: 'Only events from this canvas (default: all canvases).' },
        node_id: { type: "string", description: "Only events from this UI node." },
        id: { type: "string", description: "Alias for node_id" },
        since: { type: "number", description: "Only events with id greater than this (use the last id you saw)." },
        limit: { type: "number", description: "Max events to return (default 50, max 200)." },
        clear: { type: "boolean", description: "Remove the returned events from the log." },
      },
    },
    run: async (a) => {
      const q = new URLSearchParams();
      if (a.canvas) q.set("canvas", a.canvas);
      if (a.node_id ?? a.id) q.set("node", a.node_id ?? a.id);
      if (a.since !== undefined) q.set("since", String(a.since));
      if (a.limit !== undefined) q.set("limit", String(a.limit));
      if (a.clear) q.set("clear", "1");
      const list = await api("GET", `/api/ui-events${q.size ? `?${q}` : ""}`);
      if (!list.length) return a.since !== undefined ? `No new UI events since #${a.since}.` : "No UI events yet.";
      const lines = list.map((e: any) =>
        `#${e.id} ${e.at} canvas=${e.canvasId} node=${e.nodeId} type=${e.type} payload=${JSON.stringify(e.payload)}`,
      );
      return `${lines.length} event(s):\n${lines.join("\n")}`;
    },
  },
  {
    name: "delete_node",
    description: "Delete an item (and its arrows).",
    inputSchema: { type: "object", properties: { id: { type: "string" }, node_id: { type: "string", description: "Alias for id" } } },
    run: async (a) => {
      const id = a.id ?? a.node_id;
      if (!id) throw new Error("id (or node_id) is required");
      await api("DELETE", `/api/nodes/${encodeURIComponent(id)}`);
      return `Deleted ${id}.`;
    },
  },
  {
    name: "connect",
    description: "Draw an arrow between two items on the same canvas, e.g. screen flow (login → dashboard) or diagram → mockup.",
    inputSchema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" }, label: { type: "string" } },
      required: ["from", "to"],
    },
    run: async (a) => { const e = await api("POST", `/api/canvases/_/edges`, a); return `Connected ${a.from} → ${a.to} (edge id=${e.id}).`; },
  },
  {
    name: "disconnect",
    description: "Remove an arrow by edge id.",
    inputSchema: { type: "object", properties: { edge_id: { type: "string" } }, required: ["edge_id"] },
    run: async (a) => { await api("DELETE", `/api/edges/${encodeURIComponent(a.edge_id)}`); return `Removed ${a.edge_id}.`; },
  },
  {
    name: "focus",
    description: "Pan the user's open canvas view to an item (or the whole canvas) to draw their attention to it.",
    inputSchema: { type: "object", properties: { node_id: { type: "string" }, ...canvasProp } },
    run: async (a) => {
      let canvas = a.canvas || "main";
      if (a.node_id) canvas = (await api("GET", `/api/nodes/${encodeURIComponent(a.node_id)}`)).canvasId;
      const r = await api("POST", `/api/canvases/${encodeURIComponent(canvas)}/focus`, { nodeId: a.node_id });
      return r.viewers ? `Focused ${r.viewers} open view(s).` : `Nobody has the canvas open. Ask the user to open ${viewUrl(canvas, a.node_id)}`;
    },
  },
  {
    name: "screenshot",
    description:
      "Capture a PNG screenshot of a canvas (or a single item by node_id) and return it as an MCP image block alongside " +
      "metadata. By default (prefer_open_tab=true), attaches via Playwright CDP to an already-open canvas tab (probes " +
      "CANVAS_CDP_URL or localhost:9222/9223/9229) so you see the user's live view; falls back to headless Playwright " +
      "if no open tab is reachable.",
    inputSchema: {
      type: "object",
      properties: {
        canvas: { type: "string", description: 'Canvas id. When omitted: uses whatever canvas is active in an open tab, or "main" in headless mode.' },
        node_id: { type: "string", description: "Optional node id to capture just that item (auto-resolves its canvas)." },
        width: { type: "number", description: "Viewport width in px for headless capture (default 1440)." },
        height: { type: "number", description: "Viewport height in px for headless capture (default 900)." },
        prefer_open_tab: { type: "boolean", description: "Attach to an already-open browser tab over CDP first (default true). Set false to force a fresh headless capture." },
        cdp_url: { type: "string", description: "Optional explicit CDP endpoint (e.g. http://127.0.0.1:9222)." },
      },
    },
    run: async (a) => {
      await ensureServer();
      let canvasId: string | undefined = a.canvas || undefined;
      let nodeTitle: string | undefined;
      let nodeType: string | undefined;
      if (a.node_id) {
        const n = await api("GET", `/api/nodes/${encodeURIComponent(a.node_id)}`);
        canvasId = n.canvasId;
        nodeTitle = n.title;
        nodeType = n.type;
      } else if (canvasId) {
        await api("GET", `/api/canvases/${encodeURIComponent(canvasId)}`);
      }

      const shot = await captureScreenshot({
        baseUrl: BASE,
        canvasId,
        nodeId: a.node_id,
        width: a.width,
        height: a.height,
        preferOpenTab: a.prefer_open_tab !== false,
        cdpUrl: a.cdp_url,
      });

      const canvasInfo = await api("GET", `/api/canvases/${encodeURIComponent(shot.canvasId)}`).catch(() => null);
      const parts = [
        `Canvas: ${shot.canvasId}${canvasInfo?.name ? ` ("${canvasInfo.name}")` : ""}`,
        shot.nodeId ? `Node: ${shot.nodeId}${nodeTitle ? ` (${nodeType}: "${nodeTitle}")` : ""}` : "Scope: full canvas viewport",
        `Source: ${shot.source}${shot.cdpUrl ? ` via ${shot.cdpUrl}` : ""}`,
        `Viewport: ${shot.viewport.width}x${shot.viewport.height}`,
        `URL: ${shot.url}`,
      ];
      return [
        { type: "image", data: shot.png.toString("base64"), mimeType: "image/png" },
        { type: "text", text: parts.join(" · ") },
      ];
    },
  },
];

const INSTRUCTIONS = `Agent Canvas: a shared canvas the user watches live in the browser (${BASE}) with three modes: board, diagram, and ui.
Use it whenever a picture or live control beats prose:
- Interactive UIs (dockable workspace): create_canvas with mode="ui" for a non-infinite workspace where boards dock into resizable splits and tabs. Use create_ui to build real app boards whose JS runs live and talks back — persistent state via canvas.state, and user actions via canvas.emit, which you read with get_ui_events. Push data into a running UI with set_ui_state. Best for controls the human will actually use: settings panels, calculators, filters, approval gates, dashboards, small tools. Read get_ui_events when the user says they "tried it" / "picked one" / "filled it in". Under a host that understands notifications/composer/event (composer), what the user does in a UI card also reaches you unasked, as a notice.
- Interactive click-through diagrams (repo maps, system architectures): create_canvas with mode="diagram", add connected nodes via create_card + connect, wrap related nodes into collapsible subgraphs with create_group(children=[...]), link deeper drill-down canvases via sub_canvas_id, and optionally attach guided walkthroughs via set_canvas_mode(flows).
- UI mockups & workflows: mode="board" (infinite canvas) with create_html_board (rendered live in sandboxed iframes), create_diagram (Mermaid), and create_note (annotations).
- Peer canvases: link_canvases relates two canvases laterally (shown in the ⧉ dock in the UI), while sub_canvas_id is for parent/child drill-down.
- Portable snapshots: save_canvases_to_folder writes .canvas.json files; load_canvases_from_folder imports them as new canvases with remapped ids. Good for sharing and backups.
- Visual QA: call screenshot (by canvas or node_id) to inspect rendered mockups and diagrams as a PNG image.
Before reworking a canvas, call get_canvas: notes with author "user" are the human's feedback.
Prefer one canvas per project/topic (create_canvas), and tell the user the view URL.`;

// ---- JSON-RPC over stdio ------------------------------------------------------
const send = (msg: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

// ---- telling the agent what the user did ---------------------------------------
// A host that runs several sessions (composer) names the calling session in
// `params._meta["composer/session"]`. We remember which session last touched each canvas, and when
// the user acts inside a UI card we send `notifications/composer/event` naming that session (or no
// session: the host then picks the last caller). Hosts that don't know the notification ignore it.
const SESSION_META = "composer/session";
const canvasSession = new Map<string, string>();
let lastSession: string | undefined;

function noteCaller(params: any) {
  const session = params?._meta?.[SESSION_META];
  if (typeof session !== "string") return;
  lastSession = session;
  const args = params?.arguments ?? {};
  for (const key of ["canvas_id", "canvas", "canvasId"]) {
    if (typeof args[key] === "string") canvasSession.set(args[key], session);
  }
}

async function nodeTitle(nodeId: string): Promise<string | undefined> {
  try { return (await api("GET", `/api/nodes/${encodeURIComponent(nodeId)}`)).title; } catch { return undefined; }
}

async function forwardUiEvent(ev: { canvasId: string; nodeId: string; event: { type: string; payload: unknown; at: string } }) {
  if (!lastSession) return; // no host session has used the canvas yet: nobody to tell
  const title = await nodeTitle(ev.nodeId);
  const session = canvasSession.get(ev.canvasId);
  send({
    method: "notifications/composer/event",
    params: {
      ...(session ? { session } : {}),
      text: `the user did "${ev.event.type}" in ${title ? `"${title}"` : `node ${ev.nodeId}`} (canvas ${ev.canvasId}, node ${ev.nodeId})`,
      data: { canvasId: ev.canvasId, nodeId: ev.nodeId, type: ev.event.type, payload: ev.event.payload, at: ev.event.at },
    },
  });
}

// Follows the canvas server's event stream for as long as this process lives, reconnecting when it drops.
let following = false;
async function followEvents() {
  if (following) return;
  following = true;
  for (;;) {
    try {
      await ensureServer();
      const res = await fetch(`${BASE}/api/events`);
      if (!res.ok || !res.body) throw new Error(`events: ${res.status}`);
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
          if (!data) continue;
          let ev: any;
          try { ev = JSON.parse(data); } catch { continue; }
          if (ev.kind === "ui-event") forwardUiEvent(ev).catch((e) => log("event:", e.message));
        }
      }
    } catch (e: any) {
      log("event stream:", e.message);
    }
    // The stream ended: the server may be gone, so check (and restart it) before reconnecting.
    serverGone();
    await Bun.sleep(1000);
  }
}

async function handle(msg: any) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  switch (method) {
    case "initialize":
      ensureServer().catch((e) => log(e.message));
      followEvents();
      return send({
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "agent-canvas", version: "0.1.0" },
          instructions: INSTRUCTIONS,
        },
      });
    case "ping":
      return send({ id, result: {} });
    case "tools/list":
      return send({ id, result: { tools: tools.map(({ run, ...t }) => t) } });
    case "tools/call": {
      noteCaller(params);
      const tool = tools.find((t) => t.name === params?.name);
      if (!tool) return send({ id, error: { code: -32602, message: `unknown tool ${params?.name}` } });
      try {
        const out = await tool.run(params.arguments ?? {});
        const content: ContentBlock[] = typeof out === "string" ? [{ type: "text", text: out }] : out;
        return send({ id, result: { content } });
      } catch (e: any) {
        return send({ id, result: { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true } });
      }
    }
    default:
      return send({ id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg: any;
  try { msg = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: "parse error" } }); }
  handle(msg).catch((e) => log(e));
});
process.stdin.on("end", () => process.exit(0));
