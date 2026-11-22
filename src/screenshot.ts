// Playwright-backed screenshot capture for Agent Canvas.
// Tries an already-open canvas tab over CDP first (default), falling back to a headless Chromium launch.
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";

export interface CaptureOptions {
  baseUrl: string;
  canvasId?: string;
  nodeId?: string;
  width?: number;
  height?: number;
  /** Default true: attach to an existing browser via CDP before launching headless. */
  preferOpenTab?: boolean;
  /** Optional explicit CDP URL (overrides CANVAS_CDP_URL / default ports). */
  cdpUrl?: string;
}

export interface CaptureResult {
  png: Buffer;
  source: "open-tab" | "headless";
  cdpUrl?: string;
  canvasId: string;
  nodeId?: string;
  url: string;
  viewport: { width: number; height: number };
}

const DEFAULT_CDP_URLS = ["http://127.0.0.1:9222", "http://127.0.0.1:9223", "http://127.0.0.1:9229"];

const CHROMIUM_CANDIDATES = [
  process.env.CANVAS_CHROMIUM_PATH,
  process.env.CHROME_PATH,
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter((p): p is string => Boolean(p));

function findChromiumExecutable(): string | undefined {
  for (const p of CHROMIUM_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const hostA = ua.hostname === "127.0.0.1" ? "localhost" : ua.hostname;
    const hostB = ub.hostname === "127.0.0.1" ? "localhost" : ub.hostname;
    return ua.protocol === ub.protocol && hostA === hostB && ua.port === ub.port;
  } catch {
    return false;
  }
}

function canvasFromUrl(raw: string): string {
  try {
    return new URL(raw).searchParams.get("canvas") || "main";
  } catch {
    return "main";
  }
}

async function probeCdpEndpoints(explicit?: string): Promise<string[]> {
  const list = explicit
    ? [explicit]
    : process.env.CANVAS_CDP_URL
      ? [process.env.CANVAS_CDP_URL]
      : DEFAULT_CDP_URLS;
  const live: string[] = [];
  for (const url of list) {
    try {
      const r = await fetch(`${url.replace(/\/$/, "")}/json/version`, { signal: AbortSignal.timeout(400) });
      if (r.ok) live.push(url);
    } catch {}
  }
  return live;
}

async function waitForCanvasSettled(page: Page, expectNodeId?: string) {
  await page.waitForSelector("#viewport", { timeout: 10000 }).catch(() => {});
  if (expectNodeId) {
    await page.waitForSelector(`[data-id="${expectNodeId}"]`, { timeout: 6000 }).catch(() => {});
  }
  // Give Mermaid, web fonts, and iframes a brief window to paint
  await page.evaluate(async () => {
    try { await (document as any).fonts?.ready; } catch {}
  }).catch(() => {});
  await page.waitForTimeout(700);
}

async function captureFromOpenTab(opts: CaptureOptions): Promise<CaptureResult | null> {
  const endpoints = await probeCdpEndpoints(opts.cdpUrl);
  for (const cdpUrl of endpoints) {
    let browser: Browser | null = null;
    try {
      browser = await chromium.connectOverCDP(cdpUrl, { timeout: 1500 });
      const pages = browser.contexts().flatMap((ctx) => ctx.pages());
      const matching = pages.filter((p) => !p.isClosed() && sameOrigin(p.url(), opts.baseUrl));
      if (!matching.length) {
        await browser.close().catch(() => {});
        continue;
      }

      // Prefer a tab already showing the requested canvas, otherwise the first canvas tab
      let page =
        (opts.canvasId ? matching.find((p) => canvasFromUrl(p.url()) === opts.canvasId) : undefined) ??
        matching[0];

      const currentCanvas = canvasFromUrl(page.url());
      const targetCanvas = opts.canvasId || currentCanvas;

      // Only navigate or focus if the caller explicitly asked for a different canvas or a specific node
      if (opts.canvasId && currentCanvas !== opts.canvasId) {
        const dest = `${opts.baseUrl}/?canvas=${encodeURIComponent(targetCanvas)}${opts.nodeId ? `#node=${encodeURIComponent(opts.nodeId)}` : ""}`;
        await page.goto(dest, { waitUntil: "networkidle", timeout: 15000 });
        await waitForCanvasSettled(page, opts.nodeId);
      } else if (opts.nodeId) {
        const dest = `${opts.baseUrl}/?canvas=${encodeURIComponent(targetCanvas)}#node=${encodeURIComponent(opts.nodeId)}`;
        await page.goto(dest, { waitUntil: "networkidle", timeout: 15000 });
        await waitForCanvasSettled(page, opts.nodeId);
      }

      let png: Buffer;
      if (opts.nodeId) {
        const loc = page.locator(`[data-id="${opts.nodeId}"]`).first();
        if (await loc.count()) {
          png = await loc.screenshot({ type: "png" });
        } else {
          png = await page.screenshot({ type: "png" });
        }
      } else {
        png = await page.screenshot({ type: "png" });
      }

      const vp = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })).catch(() => ({ width: 0, height: 0 }));
      const url = page.url();
      // In connectOverCDP, browser.close() disconnects without closing the user's Chrome
      await browser.close().catch(() => {});
      return {
        png,
        source: "open-tab",
        cdpUrl,
        canvasId: canvasFromUrl(url),
        nodeId: opts.nodeId,
        url,
        viewport: vp,
      };
    } catch {
      if (browser) await browser.close().catch(() => {});
    }
  }
  return null;
}

async function captureHeadless(opts: CaptureOptions): Promise<CaptureResult> {
  const width = Math.max(320, Math.min(3840, Math.round(opts.width ?? 1440)));
  const height = Math.max(240, Math.min(2160, Math.round(opts.height ?? 900)));
  const canvasId = opts.canvasId || "main";
  const executablePath = findChromiumExecutable();

  let browser: Browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-gpu"],
    });
  } catch (e: any) {
    throw new Error(
      `Failed to launch Chromium for screenshot: ${e?.message ?? e}. ` +
      `Set CANVAS_CHROMIUM_PATH or run "bunx playwright-core install chromium".`
    );
  }

  try {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();

    // When a specific node is requested, focus it via hash; otherwise open canvas and fit all
    const url = `${opts.baseUrl}/?canvas=${encodeURIComponent(canvasId)}${opts.nodeId ? `#node=${encodeURIComponent(opts.nodeId)}` : ""}`;
    await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
    await waitForCanvasSettled(page, opts.nodeId);

    if (!opts.nodeId) {
      await page.keyboard.press("f").catch(() => {});
      await page.waitForTimeout(450);
    }

    let png: Buffer;
    if (opts.nodeId) {
      const loc = page.locator(`[data-id="${opts.nodeId}"]`).first();
      if (await loc.count()) {
        png = await loc.screenshot({ type: "png" });
      } else {
        png = await page.screenshot({ type: "png" });
      }
    } else {
      png = await page.screenshot({ type: "png" });
    }

    return {
      png,
      source: "headless",
      canvasId,
      nodeId: opts.nodeId,
      url: page.url(),
      viewport: { width, height },
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function captureScreenshot(opts: CaptureOptions): Promise<CaptureResult> {
  const preferOpen = opts.preferOpenTab !== false;
  if (preferOpen) {
    const live = await captureFromOpenTab(opts);
    if (live) return live;
  }
  return captureHeadless(opts);
}
