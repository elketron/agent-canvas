import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep tests away from the real data/ directory. This preload runs before any
// test file imports the store (which reads these paths at module load).
const dir = mkdtempSync(join(tmpdir(), "agent-canvas-test-"));
process.env.CANVAS_DATA_DIR = join(dir, "canvases");
process.env.CANVAS_EVENTS_FILE = join(dir, "ui-events.json");
