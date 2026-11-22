// Seeds (or refreshes) the "Canvas UI demo" canvas with the interactive demo apps.
// Usage: bun scripts/demo-canvas-ui.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.CANVAS_URL ?? `http://localhost:${process.env.CANVAS_PORT ?? 4477}`;
const NAME = "Canvas UI demo";
const DIR = join(import.meta.dir, "demo-uis");

const read = (file: string) => readFileSync(join(DIR, file), "utf8");

const DEMOS = [
  { title: "Plan builder", file: "plan-builder.html", x: 0, y: 0, w: 520, h: 660 },
  { title: "Approval gate", file: "approval-gate.html", x: 600, y: 0, w: 440, h: 340 },
  { title: "State inspector", file: "state-inspector.html", x: 600, y: 440, w: 440, h: 400 },
  { title: "JSON tool", file: "json-tool.html", x: 0, y: 800, w: 560, h: 540 },
  {
    title: "Try the loop",
    type: "note",
    x: 1100, y: 0, w: 400, h: 380,
    content: [
      "### Try the loop",
      "",
      "1. Change the plan or seats, then hit **Send to agent**.",
      "2. Ask the agent: *“what plan did I just pick?”* → it calls `get_ui_events`.",
      "3. Hit **Approve** on the release gate and ask *“did I approve the deploy?”*",
      "4. Reload the canvas: the counter and inputs are still there (`canvas.state`).",
      "5. Ask the agent to *“push a new counter value into the inspector”* → `set_ui_state` updates the live app.",
      "",
      "Every card was created with `create_ui`; their source is plain HTML in `scripts/demo-uis/`.",
    ].join("\n"),
  },
];

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${data.error ?? res.statusText}`);
  return data;
}

const canvases = await api("GET", "/api/canvases");
let canvas = canvases.find((c: any) => c.name === NAME);
if (!canvas) {
  canvas = await api("POST", "/api/canvases", { name: NAME, mode: "ui" });
  console.log(`created canvas "${NAME}" (${canvas.id})`);
} else {
  if (canvas.mode !== "ui") await api("PATCH", `/api/canvases/${encodeURIComponent(canvas.id)}`, { mode: "ui" });
  console.log(`using canvas "${NAME}" (${canvas.id})`);
}

const full = await api("GET", `/api/canvases/${encodeURIComponent(canvas.id)}`);
for (const demo of DEMOS) {
  const existing = full.nodes.find((n: any) => n.title === demo.title && n.type === (demo.type ?? "html"));
  const payload: Record<string, unknown> = {
    title: demo.title,
    x: demo.x, y: demo.y, w: demo.w, h: demo.h,
    ...(demo.type === "note" ? { content: demo.content, author: "user" } : { content: read(demo.file!), author: "agent" }),
  };
  if (existing) {
    await api("PATCH", `/api/nodes/${encodeURIComponent(existing.id)}`, payload);
    console.log(`updated ${demo.title} (${existing.id})`);
  } else {
    const n = await api("POST", `/api/canvases/${encodeURIComponent(canvas.id)}/nodes`, { type: demo.type ?? "html", ...payload });
    console.log(`created ${demo.title} (${n.id})`);
  }
}

console.log(`\nOpen: ${BASE}/?canvas=${encodeURIComponent(canvas.id)}`);
