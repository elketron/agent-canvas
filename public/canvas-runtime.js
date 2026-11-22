/*
 * Canvas UI runtime — injected by the canvas server into every HTML node.
 *
 * Gives app code a small host API via `window.canvas`:
 *   canvas.node            { id, canvasId, title }
 *   canvas.theme           design tokens (noema palette)
 *   canvas.state.get()     current persistent state (also .current() for sync)
 *   canvas.state.set(v)    replace state
 *   canvas.state.update(p) shallow-merge an object, or fn(current)
 *   canvas.emit(type, data)  send a user action to the server (the agent can read it)
 *   canvas.on/off(event, fn) "state" | "ready" | "error"
 *   canvas.notify(text)    toast in the canvas UI
 *   canvas.resize({height, width})  grow/shrink the card to fit the app
 *   canvas.setTitle(text)  rename the card
 *   canvas.open(id)        open a node on this canvas, or another canvas by id
 *   canvas.focus(id)       pan the canvas to a node
 *
 * Works in two modes:
 *   - inside the canvas (sandboxed iframe): talks to the host UI over postMessage
 *   - standalone (/api/nodes/:id/app opened in its own tab): talks to the HTTP API directly
 */
(() => {
  const host = window.__canvasHost || {};
  const node = { id: host.nodeId, canvasId: host.canvasId, title: host.title };
  const standalone = window.parent === window;
  // Where the canvas server's root is: this page is <root>/api/nodes/<id>/app, and <root> may be a
  // path prefix when a proxy serves the canvas (e.g. composer at /apps/canvas/).
  const root = location.pathname.replace(/\/api\/nodes\/[^/]*\/[^/]*$/, "");
  const listeners = new Map();
  const pending = new Map();
  let seq = 0;

  const theme = {
    bg: "#0e0e0f", bgDeep: "#0a0a0b", panel: "#111112", panel2: "#131315",
    surface: "#171718", surface2: "#1a1a1c", border: "#222224", border2: "#2a2a2c",
    fg: "#c2c0b6", fgBright: "#d8d6cc", fgDim: "#8a8880", fgFaint: "#6a6865",
    accent: "#4e46a0", accentHi: "#5e56b0", accentSoft: "#8a82cc",
    accentDeep: "#12111a", accentBorder: "#2a2740",
    ok: "#4CAF82", warn: "#d4a843", err: "#e05a5a",
    font: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    ...(host.theme || {}),
  };

  let state = host.state !== undefined ? host.state : null;
  let stateJson = JSON.stringify(state);
  let autosizeStarted = false;
  let autosizeTimer;
  let autosizeObserver;

  function measure() {
    if (!autosizeStarted || !innerWidth || !innerHeight) return; // still hidden / not attached
    const height = Math.ceil(document.body.getBoundingClientRect().height) + 2;
    if (height > 0) canvas.resize({ height });
  }

  function dispatch(name, data) {
    for (const fn of listeners.get(name) || []) {
      try { fn(data); } catch (e) { console.error(`[canvas] ${name} listener failed:`, e); }
    }
  }

  function setLocalState(next) {
    const json = JSON.stringify(next ?? null);
    if (json === stateJson) return false;
    state = JSON.parse(json);
    stateJson = json;
    dispatch("state", state);
    return true;
  }

  // ---- transport ------------------------------------------------------------
  async function direct(method, params) {
    const base = `${root}/api/nodes/${encodeURIComponent(node.id)}`;
    if (method === "state.get") {
      const r = await fetch(`${base}/state`);
      const j = await r.json();
      return j.state ?? null;
    }
    if (method === "state.set") {
      const r = await fetch(`${base}/state`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: params.state ?? null }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      return j.state ?? null;
    }
    if (method === "emit") {
      const r = await fetch(`${base}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: params.type, payload: params.payload }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      return true;
    }
    if (method === "open") {
      let canvasId = params.canvasId;
      if (params.nodeId && !canvasId) {
        try {
          const info = await (await fetch(`${root}/api/nodes/${encodeURIComponent(params.nodeId)}`)).json();
          canvasId = info.canvasId;
        } catch {}
      }
      location.href = `${root}/?canvas=${encodeURIComponent(canvasId || "main")}#node=${encodeURIComponent(params.nodeId || "")}`;
      return true;
    }
    return false; // resize / focus / setTitle / notify have no meaning standalone
  }

  function call(method, params) {
    if (standalone) return direct(method, params).catch((e) => { dispatch("error", e); throw e; });
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`canvas host did not answer ${method}`)); }, 20000);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      window.parent.postMessage({ __canvas: true, kind: "rpc", id, method, params }, "*");
    });
  }

  if (!standalone) {
    window.addEventListener("message", (e) => {
      const msg = e.data;
      if (!msg || msg.__canvas !== true || e.source !== window.parent) return;
      if (msg.kind === "result") {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new Error(msg.error || "canvas host error"));
      } else if (msg.kind === "state:sync") {
        setLocalState(msg.state);
      }
    });
  }

  // ---- public API -----------------------------------------------------------
  const canvas = {
    node,
    theme,
    standalone,
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => canvas.off(name, fn);
    },
    off(name, fn) {
      listeners.get(name)?.delete(fn);
    },
    state: {
      current: () => state,
      async get() {
        const next = await call("state.get");
        if (next !== undefined) setLocalState(next);
        return state;
      },
      async set(value) {
        setLocalState(value);
        const saved = await call("state.set", { state: value });
        if (saved !== undefined) setLocalState(saved);
        return state;
      },
      async update(patch) {
        const current = state && typeof state === "object" ? state : {};
        const next = typeof patch === "function" ? await patch(current) : { ...current, ...patch };
        return canvas.state.set(next ?? current);
      },
    },
    emit(type, payload) {
      return call("emit", { type: String(type ?? "event"), payload: payload ?? null }).catch(() => {});
    },
    notify(text) {
      return call("notify", { text: String(text ?? "") }).catch(() => {});
    },
    resize(size) {
      const params = typeof size === "number" ? { height: size } : (size || {});
      return call("resize", params).catch(() => {});
    },
    /**
     * Make the card fit the app's content: measures the body once layout is ready
     * (skipping the zero-size window while the iframe is being attached) and keeps
     * following content changes with a ResizeObserver. Content-sized apps only —
     * don't use 100vh sections, or it will chase its own tail.
     */
    autosize() {
      if (standalone) return;
      if (!autosizeStarted) {
        autosizeStarted = true;
        const schedule = () => {
          clearTimeout(autosizeTimer);
          autosizeTimer = setTimeout(measure, 80);
        };
        const onLoad = () => requestAnimationFrame(() => requestAnimationFrame(measure));
        if (document.readyState === "complete") onLoad();
        else addEventListener("load", onLoad, { once: true });
        try {
          autosizeObserver = new ResizeObserver(schedule);
          autosizeObserver.observe(document.body);
        } catch {}
      }
      clearTimeout(autosizeTimer);
      autosizeTimer = setTimeout(measure, 30);
    },
    setTitle(title) {
      node.title = String(title ?? "");
      return call("setTitle", { title: node.title }).catch(() => {});
    },
    open(id) {
      return call("open", { id: String(id ?? "") }).catch(() => {});
    },
    focus(id) {
      return call("focus", { nodeId: String(id ?? "") }).catch(() => {});
    },
  };

  window.canvas = canvas;

  // Apps fire this promise in `await canvas.ready` if they want to be sure state is loaded.
  canvas.ready = (async () => {
    if (standalone) {
      try { setLocalState(await call("state.get")); } catch {}
    }
    dispatch("ready", { node, state });
    return state;
  })();

  // Handy default: announce mount so the console shows the runtime is live.
  console.debug(`[canvas] runtime ready for node ${node.id} (${standalone ? "standalone" : "in canvas"})`);
})();
