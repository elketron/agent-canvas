import { describe, expect, test } from "bun:test";
import * as store from "../src/store";

describe("store", () => {
  test("creates canvases with unique slugs and places nodes automatically", () => {
    const a = store.createCanvas("Store Test");
    const b = store.createCanvas("Store Test");
    expect(a.id).toBe("store-test");
    expect(b.id).toBe("store-test-2");

    const first = store.addNode(a.id, { type: "note", content: "one", author: "user" });
    const second = store.addNode(a.id, { type: "note", content: "two" });
    expect(first.author).toBe("user");
    expect(second.x).toBeGreaterThan(first.x);
    expect(store.getCanvas(a.id).nodes).toHaveLength(2);
  });

  test("keeps previous content as a version and bumps rev", () => {
    const canvas = store.createCanvas("Version Test");
    const node = store.addNode(canvas.id, { type: "note", content: "v1" });
    const { node: updated } = store.updateNode(node.id, { content: "v2", title: "Renamed" });

    expect(updated.rev).toBe(2);
    expect(updated.history).toHaveLength(1);
    expect(updated.history[0]).toMatchObject({ title: "Note", content: "v1" });
  });

  test("rejects app state on non-html nodes and caps oversized state", () => {
    const canvas = store.createCanvas("State Test");
    const note = store.addNode(canvas.id, { type: "note", content: "hi" });
    expect(() => store.setNodeState(note.id, { ok: true })).toThrow(/not an interactive html app/);

    const app = store.addNode(canvas.id, { type: "html", content: "<html></html>" });
    expect(() => store.setNodeState(app.id, { blob: "x".repeat(200 * 1024) })).toThrow(/limit is 128 KB/);
    expect(store.setNodeState(app.id, { ok: true }).node.state).toEqual({ ok: true });
  });

  test("connects nodes on the same canvas only", () => {
    const a = store.createCanvas("Edge A");
    const b = store.createCanvas("Edge B");
    const na = store.addNode(a.id, { type: "note", content: "a" });
    const nb = store.addNode(b.id, { type: "note", content: "b" });
    expect(() => store.addEdge(na.id, nb.id)).toThrow(/different canvases/);

    const other = store.addNode(a.id, { type: "note", content: "c" });
    const { edge } = store.addEdge(na.id, other.id, "next");
    expect(store.getCanvas(a.id).edges).toContainEqual({ id: edge.id, from: na.id, to: other.id, label: "next" });
  });

  test("imports snapshots as new canvases and remaps every reference", () => {
    const snapshot = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
      id,
      name,
      mode: "diagram",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [
        {
          id: `${id}-n1`, type: "card", title: "One", content: "details", x: 0, y: 0, w: 260, h: 118,
          author: "agent", rev: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), history: [],
        },
        {
          id: `${id}-n2`, type: "card", title: "Two", content: "", x: 300, y: 0, w: 260, h: 118,
          author: "agent", rev: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), history: [],
        },
      ],
      edges: [{ id: `${id}-e1`, from: `${id}-n1`, to: `${id}-n2`, label: "calls" }],
      links: extra.links ?? [],
      ...extra,
    });

    const one = snapshot("snap-one", "Snap One", { parentCanvasId: "snap-two", links: ["snap-two"] });
    const two = snapshot("snap-two", "Snap Two", { links: ["snap-one"] });
    const [importedOne, importedTwo] = store.importCanvasSnapshots(
      [one as any, two as any],
      "restored-",
    );

    expect(importedOne.originalId).toBe("snap-one");
    expect(importedOne.name).toBe("restored-Snap One");
    expect(importedOne.id).not.toBe("snap-one");

    const restored = store.getCanvas(importedOne.id);
    const restoredTwo = store.getCanvas(importedTwo.id);
    expect(restored.links).toEqual([restoredTwo.id]);
    expect(restoredTwo.links).toEqual([restored.id]);
    expect(restored.parentCanvasId).toBe(restoredTwo.id);

    // Edge endpoints point at the freshly allocated node ids, not the imported ones.
    const edge = restored.edges[0];
    const nodeIds = restored.nodes.map((n) => n.id);
    expect(nodeIds).toContain(edge.from);
    expect(nodeIds).toContain(edge.to);
    expect(edge.from).not.toBe("snap-one-n1");
    expect(edge.label).toBe("calls");
  });
});
