# Agent Canvas

An infinite canvas that an AI agent draws on through MCP, and that you watch and edit live in the browser.

- **HTML boards**: UI mockups, rendered live in sandboxed iframes. Tailwind or other CDN scripts work.
- **UI mode (`mode: "ui"`)**: its own dedicated non-infinite workspace mode alongside **Board** and **Diagram**, with **dockable boards** (resizable horizontal/vertical splits, drag-to-dock drop zones, tabbed panes, maximize/restore, and a minimized dock shelf). HTML items are *live apps* with a `window.canvas` API (persistent state, events back to the agent), so each docked board can be a real settings panel, calculator, dashboard, or approval gate.
- **Diagrams**: Mermaid (flowcharts, sequence, ER, class, C4, architecture…).
- **Notes**: markdown stickies. Notes you add are tagged `author: "user"`, so the agent can read them as feedback.
- **Related canvases**: link peer canvases with the ⧉ picker; they appear in a bottom-left dock with back/forward history.
- **Folder snapshots**: save canvases to a folder as portable `.canvas.json` files and load them back; IDs are remapped so imports never overwrite.
- **Arrows** between items, **version history** for every edit, and **multiple canvases** (one per project or topic).
- Everything is saved as JSON in `data/canvases/`.

Needs [Bun](https://bun.sh) 1.2+ (plus `playwright-core` for the `screenshot` tool).
By default the server listens on `127.0.0.1` only — it is a local tool, not a network service.

## Use it

```sh
bun install          # one dependency: playwright-core
bun start            # canvas at http://localhost:4477 (optional: the MCP server starts it on demand)
```

In this folder, Claude Code and OpenCode pick up `.mcp.json` / `opencode.json` automatically. To use the
canvas from **any** project (for example, to diagram that project's architecture):

```sh
claude mcp add --scope user canvas -- bun ~/Projects/agent-canvas/src/mcp.ts
```

Then ask, for example: *"Diagram this app's architecture on the canvas"* or *"Mock up 3 variants of the settings page on a new canvas"*.

Run `bun run demo` to seed the **“Canvas UI demo”** canvas with four interactive apps and try the loop yourself.
Run `bun run demo:incident` for a bigger example: an Azure-style incident report (Application Insights metrics,
Function App resources, triage checklist) whose acknowledge/mitigate/resolve actions change the live data and emit events.

## Canvas UI mode

Every HTML item runs real JavaScript inside a sandboxed iframe. The server injects a small runtime
(`public/canvas-runtime.js`) that gives the page a host API, bridged over `postMessage`:

| call | what it does |
|---|---|
| `canvas.state.get()` / `.set(v)` / `.update(patch)` / `.current()` | persistent JSON for this card (128 KB cap, not part of version history) |
| `canvas.emit(type, payload)` | record a user action — the agent reads these with `get_ui_events` |
| `canvas.on('state', fn)` | react when the agent pushes new state with `set_ui_state` |
| `canvas.autosize()` | make the card fit the app’s content (sizes once layout is ready, then follows changes) |
| `canvas.resize({height, width})` | manual size in iframe-viewport pixels (the card adds its header) |
| `canvas.notify(text)` / `canvas.setTitle(t)` | toast in the canvas UI / rename the card |
| `canvas.open(nodeIdOrCanvasId)` / `canvas.focus(nodeId)` | navigate or pan to something |
| `canvas.theme`, `canvas.node`, `canvas.standalone` | palette tokens, `{id, title, canvasId}`, and whether it’s running standalone |

The point is the loop, not the animation: the agent draws a control, you use it, and your input comes
back as data. `↗` opens the app full-page at `/api/nodes/:id/app` — the same API works there, talking
to the server directly, so the state and event log are shared with the canvas.

Editing a card’s content reloads only that app; state, title and position changes don’t reload it.
Apps should call `canvas.autosize()` (or `canvas.resize()`) if they want their card to fit.
Double-click an app card (header or edge) to zoom it to 1:1 for comfortable use.

The four demo apps live in `scripts/demo-uis/` and are good starting points:
`plan-builder.html` (state + emit), `approval-gate.html` (a decision the agent reads),
`state-inspector.html` (persistence across reloads), `json-tool.html` (a small utility).
`incident-report.html` is the larger incident demo: live KPIs, expandable Azure resources,
a timeline, triage checklist, notes, and status actions that emit events.

## Agent tools

| tool | purpose |
|---|---|
| `create_html_board` / `create_diagram` / `create_note` | draw items (auto-placed unless x/y given) |
| `create_ui` | create an interactive app card (state, `canvas.emit`, `canvas.on('state')`) |
| `set_ui_state` | push JSON into a live app; the running UI updates immediately |
| `get_ui_events` | read the actions the user performed inside UIs (`since`, `clear` supported) |
| `update_node` | full replace or cheap find/replace `edits`; old content is kept as a version |
| `get_canvas` / `get_node` | read the canvas back, including your notes |
| `link_canvases` / `unlink_canvases` | relate two canvases as peers (symmetric) |
| `save_canvases_to_folder` / `load_canvases_from_folder` | portable `.canvas.json` snapshots |
| `connect` / `disconnect` | arrows between items |
| `focus` | pan your browser view to an item |
| `screenshot` | capture a canvas or single item as a PNG image block (Playwright CDP open tab → headless fallback) |
| `list_canvases` / `create_canvas` / `delete_node` | housekeeping |

## Folder snapshots

`save_canvases_to_folder` writes one `.canvas.json` per canvas (pass `canvas_ids`, or omit to save everything).
`load_canvases_from_folder` imports every `.canvas.json` in that folder as **new** canvases — canvas, node and
edge ids are remapped, so loading never overwrites existing work. Links, parent/child canvases, drill-down
sub-canvases, edges and flows are preserved when the referenced canvases are all in the folder.

Example: *“Save the repo graph and both drill-down canvases to `~/canvas-backups/repo`, then load it back with
the prefix `restored-`.”*

## UI

Drag the background to pan · Ctrl/⌘ + scroll to zoom · drag a header to move · drag the corner to resize ·
✎ edits source and restores old versions · ↗ opens the item full-page · double-click adds a note · F fits everything on screen ·
⧉ relates canvases · ← / → (or Alt+← / Alt+→) walk back and forward between them.

## Configuration

All configuration is environment-based; there are no config files to edit.

| variable | default | purpose |
|---|---|---|
| `CANVAS_PORT` | `4477` | HTTP/SSE port |
| `CANVAS_HOST` | `127.0.0.1` | bind address. Set `0.0.0.0` only if you deliberately want LAN access |
| `CANVAS_DATA_DIR` | `data/canvases` | where canvas JSON files live |
| `CANVAS_EVENTS_FILE` | `data/ui-events.json` | persisted UI event log |
| `CANVAS_URL` | `http://localhost:$CANVAS_PORT` | MCP client target; set it to use an already-running server |
| `CANVAS_CDP_URL` | probes `127.0.0.1:9222/9223/9229` | Chrome DevTools endpoint for open-tab screenshots |
| `CANVAS_CHROMIUM_PATH` | common system paths | Chromium binary for headless screenshots |

## Development

```sh
bun test             # store + import/export tests (isolated temp data dir)
```

`data/` is gitignored: it holds your canvases, the UI event log and `server.log`. The demo scripts seed
throwaway example canvases and are safe to run against a fresh checkout.

## Layout

```
src/store.ts       file-backed canvas/node/edge store (incl. per-node app state)
src/events.ts      ring-buffered log of UI events (data/ui-events.json)
src/server.ts      REST API + SSE + static UI + runtime injection (port 4477, env CANVAS_PORT)
src/screenshot.ts  Playwright CDP (open tab) + headless PNG capture
src/mcp.ts         stdio MCP server → calls the HTTP API; starts server.ts in the background if needed
public/app.js      canvas UI; host side of the postMessage app bridge
public/canvas-runtime.js  the window.canvas API injected into every HTML app
scripts/           demo seeding + demo app sources
tests/             store and import/export tests
```
