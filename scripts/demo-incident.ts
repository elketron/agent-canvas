// Seeds (or refreshes) the "Incident INC-2026-114" canvas with the interactive incident report demo.
// Usage: bun scripts/demo-incident.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.CANVAS_URL || `http://localhost:${process.env.CANVAS_PORT || 4477}`;
const DIR = join(import.meta.dir, "demo-uis");
const NAME = "Incident INC-2026-114";

const html = readFileSync(join(DIR, "incident-report.html"), "utf8");

const NOTE = [
  "## Try the incident demo",
  "",
  "1. **Acknowledge → Mitigate → Resolve.** The KPIs recover and the timer stops.",
  "2. Click a resource row (Application Insights / Function App) for the KQL and invocation logs.",
  "3. Tick a triage item or save a note — the agent can read it.",
  "4. **Hand to agent**, then ask: *“what's the incident status and what did I do?”*",
  "5. The agent can push changes back: *“add an agent note to the incident”* or *“mark it mitigated”*.",
  "",
  "Everything persists across reloads (state lives on the card), and every action is an event in `get_ui_events`.",
].join("\n");

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const canvases = await api("GET", "/api/canvases");
let canvas = canvases.find((c: any) => c.name === NAME);
if (!canvas) {
  canvas = await api("POST", "/api/canvases", { name: NAME, mode: "ui" });
  console.log(`created canvas ${canvas.id} (${NAME})`);
} else {
  if (canvas.mode !== "ui") await api("PATCH", `/api/canvases/${encodeURIComponent(canvas.id)}`, { mode: "ui" });
  console.log(`using canvas ${canvas.id} (${NAME})`);
}

const full = await api("GET", `/api/canvases/${encodeURIComponent(canvas.id)}`);
const wanted = [
  { title: "Incident INC-2026-114", type: "html", x: 0, y: 0, w: 680, h: 900, content: html },
  { title: "Try the incident demo", type: "note", x: 720, y: 0, w: 400, h: 330, content: NOTE },
];

for (const item of wanted) {
  const existing = full.nodes.find((n: any) => n.title === item.title && n.type === item.type);
  if (existing) {
    await api("PATCH", `/api/nodes/${encodeURIComponent(existing.id)}`, {
      content: item.content, x: item.x, y: item.y, w: item.w, h: item.h,
    });
    console.log(`updated ${item.title} (${existing.id})`);
  } else {
    const created = await api("POST", `/api/canvases/${encodeURIComponent(canvas.id)}/nodes`, {
      ...item, author: "agent",
    });
    console.log(`created ${item.title} (${created.id})`);
  }
}

console.log(`\nOpen: ${BASE}/?canvas=${encodeURIComponent(canvas.id)}`);
