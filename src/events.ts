// Event log for interactive canvas UIs: what a person did inside an app, for the agent to read back.
// In-memory ring buffer, persisted to data/ui-events.json so events survive restarts.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface UiEvent {
  id: number;
  at: string;
  canvasId: string;
  nodeId: string;
  type: string;
  payload: unknown;
}

const DATA_DIR = process.env.CANVAS_DATA_DIR ?? join(import.meta.dir, "..", "data", "canvases");
const FILE = process.env.CANVAS_EVENTS_FILE ?? join(dirname(DATA_DIR), "ui-events.json");
const MAX_EVENTS = 500;
const MAX_TYPE = 120;
const MAX_PAYLOAD = 32 * 1024;

let events: UiEvent[] = [];
let nextId = 1;

try {
  const raw = JSON.parse(readFileSync(FILE, "utf8"));
  if (Array.isArray(raw)) events = raw.filter((e) => e && typeof e === "object" && typeof e.type === "string");
  for (const e of events) nextId = Math.max(nextId, Number(e.id) + 1);
} catch {
  // no log yet
}

let flushTimer: ReturnType<typeof setTimeout> | undefined;
function persist() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    try {
      mkdirSync(dirname(FILE), { recursive: true });
      writeFileSync(FILE, JSON.stringify(events));
    } catch (e) {
      console.error("could not persist ui events:", e);
    }
  }, 250);
}

export function recordEvent(canvasId: string, nodeId: string, type: unknown, payload: unknown): UiEvent {
  const kind = String(type ?? "event").slice(0, MAX_TYPE) || "event";
  let data = payload;
  try {
    const json = JSON.stringify(payload ?? null);
    data = json.length > MAX_PAYLOAD ? { truncated: true, preview: json.slice(0, MAX_PAYLOAD) } : JSON.parse(json);
  } catch {
    data = { note: "payload was not JSON-serialisable", text: String(payload).slice(0, 2000) };
  }
  const ev: UiEvent = { id: nextId++, at: new Date().toISOString(), canvasId, nodeId, type: kind, payload: data };
  events.push(ev);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  persist();
  return ev;
}

export function listEvents(
  opts: { canvasId?: string; nodeId?: string; since?: number; limit?: number; clear?: boolean } = {},
): UiEvent[] {
  const since = Number(opts.since);
  let out = events.filter((e) =>
    (!opts.canvasId || e.canvasId === opts.canvasId) &&
    (!opts.nodeId || e.nodeId === opts.nodeId) &&
    (!Number.isFinite(since) || e.id > since),
  );
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
  out = out.slice(-limit);
  if (opts.clear && out.length) {
    const ids = new Set(out.map((e) => e.id));
    events = events.filter((e) => !ids.has(e.id));
    persist();
  }
  return out;
}

/** Drop the log for a node that was deleted. */
export function removeNodeEvents(nodeId: string): number {
  const before = events.length;
  events = events.filter((e) => e.nodeId !== nodeId);
  if (events.length !== before) persist();
  return before - events.length;
}
