import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyHoverRetries } from "./test-hover-retry.mjs";
import { verifySummaryCards } from "./test-summary-card.mjs";
import { verifyBookmarkCards } from "./test-bookmarks.mjs";
export { verifyHoverRetries, verifySummaryCards, verifyBookmarkCards };

export async function installFixture(worker) {
  await worker.evaluate(() => {
    globalThis.axccNativeFetch ||= globalThis.fetch;
    globalThis.axccTestMode = "success";
    globalThis.axccTestRequests = [];
    globalThis.axccTestBibliographies = [];
    globalThis.axccTestReferenceFailures = 0;
    globalThis.axccTestReferenceTimes = [];
    globalThis.axccTestReferenceRetryAfter = 0;
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.hostname === "www.alphaxiv.org" && url.pathname.endsWith(".md")) {
        axccTestBibliographies.push(url.href);
        return new Response("References\n[1] Niket Agarwal et al. 2025. Cosmos World Foundation Model Platform for Physical AI. arXiv:2501.03575");
      }
      if (url.hostname !== "api.semanticscholar.org") return axccNativeFetch(input, init);
      axccTestRequests.push(url.href);
      const mode = axccTestMode;
      const respond = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
        status, headers: { "Content-Type": "application/json", ...headers },
      });
      const isReference = decodeURIComponent(url.pathname).includes("ARXIV:2501.03575");
      if (isReference) {
        axccTestReferenceTimes.push(Date.now());
        if (axccTestReferenceFailures > 0) {
          axccTestReferenceFailures--;
          return respond({}, 429, axccTestReferenceRetryAfter ? { "Retry-After": String(axccTestReferenceRetryAfter) } : {});
        }
        if (mode === "busy-reference") return respond({}, 429);
        if (mode === "missing-reference") return respond({}, 404);
        if (mode === "auth-reference") return respond({}, 403);
      }
      if (init.headers?.["x-api-key"] === "bad-key") return respond({}, 403);
      if (mode === "busy") return respond({}, 429);
      if (mode === "missing") return respond({}, 404);
      const paperForId = id => {
        if (id.includes("2508.08241")) return {
          paperId: "beyondmimic-id",
          title: "BeyondMimic: From Motion Tracking to Versatile Humanoid Control via Guided Diffusion",
          citationCount: 731,
          externalIds: { ArXiv: "2508.08241" },
        };
        if (id.includes("2503.11801")) return {
          paperId: "diffuse-cloc-id",
          title: "Diffuse-CLoC: Guided Diffusion for Physics-based Character Look-ahead Control",
          citationCount: 42,
          externalIds: { ArXiv: "2503.11801" },
        };
        const flow = id.includes("2210.02747");
        const source = id.includes("2601.16163");
        return {
          paperId: flow ? "flow-matching-id" : source ? "cosmos-policy-id" : "cosmos-platform-id",
          title: flow ? "Flow Matching for Generative Modeling" : source
            ? "Cosmos Policy: Fine-Tuning Video Models for Visuomotor Control and Planning"
            : "Cosmos World Foundation Model Platform for Physical AI",
          citationCount: flow ? 3654 : source ? 412 : 1234,
          year: flow ? 2023 : source ? 2026 : 2025,
          externalIds: { ArXiv: flow ? "2210.02747" : source ? "2601.16163" : "2501.03575" },
          authors: [{ name: flow ? "Yaron Lipman" : source ? "Moo Jin Kim" : "Niket Agarwal" }],
        };
      };
      if (url.pathname.endsWith("/batch")) return respond(JSON.parse(init.body).ids.map(paperForId));
      return respond(paperForId(decodeURIComponent(url.pathname)));
    };
  });
}

export async function verifyExtension(context, worker, page, outputDir, assertions) {
  await mkdir(outputDir, { recursive: true });
  const expect = assertions || createRequire(import.meta.url)("playwright/test").expect;
  page.setDefaultTimeout(10_000);
  const main = page.locator(".axcc-paper-count");
  const hover = page.locator(".axcc-citation-count:not(.axcc-paper-count)").first();
  const reset = mode => worker.evaluate(async mode => {
    globalThis.axccTestMode = mode;
    const all = await chrome.storage.local.get(null);
    await chrome.storage.local.remove(Object.keys(all).filter(key => key.startsWith("axcc:")));
    await chrome.storage.local.set({ axccConfigRevision: Date.now() });
  }, mode);
  await worker.evaluate(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ axccEnabled: true });
  });
  await page.bringToFront();
  await page.goto("https://www.alphaxiv.org/abs/2601.16163", { waitUntil: "domcontentloaded" });
  await expect(main).toHaveText(/412 citations\s*Semantic Scholar/);
  await expect(main).toHaveCount(1);
  assert.equal(await worker.evaluate(() => axccTestRequests.length), 1);
  assert.equal(await worker.evaluate(() => axccTestBibliographies.length), 0);
  await page.screenshot({ path: join(outputDir, "fixture-abstract.png"), scale: "css" });

  await page.getByRole("link", { name: "Paper", exact: true }).click();
  await expect(main).toHaveClass(/axcc-paper-reader/);
  await expect(main).toBeVisible();
  assert.equal(await worker.evaluate(() => axccTestRequests.length), 1);
  const pageNumber = page.getByRole("tablist", { name: "Paper", exact: true }).locator("..").locator('input[type="text"]');
  await pageNumber.fill("2");
  await pageNumber.press("Enter");
  const citation = page.locator('a[href="#cite.nvidia2025cosmosworldfoundationmodel"]').first();
  await citation.waitFor({ state: "visible" });
  const openCitation = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.mouse.move(1200, 100);
      await page.locator(".absolute.z-50").waitFor({ state: "hidden" });
      await citation.hover();
      try {
        await hover.waitFor({ state: "visible", timeout: 2_000 });
        return;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
  };
  await openCitation();
  await expect(hover).toHaveText(/1,234 citations\s*Semantic Scholar/);
  assert.equal(await worker.evaluate(() => axccTestRequests.length), 2);
  assert.equal(await worker.evaluate(() => axccTestBibliographies.length), 0);
  const countBefore = await worker.evaluate(() => axccTestRequests.length);
  await page.waitForTimeout(1_500);
  await expect(hover).toHaveText(/1,234 citations\s*Semantic Scholar/);
  assert.equal(await worker.evaluate(() => axccTestRequests.length), countBefore);
  await page.screenshot({ path: join(outputDir, "fixture-hover.png"), scale: "css" });
  await expect(hover.locator("a.axcc-result")).toHaveAttribute("href", /semanticscholar\.org\/paper\//);

  const preloadPopup = await context.newPage();
  await preloadPopup.goto(new URL("popup.html", worker.url()).href);
  await expect(preloadPopup.locator("#preload-references")).not.toBeChecked();
  await preloadPopup.locator("#preload-references").check();
  await expect.poll(() => worker.evaluate(() => axccTestRequests.filter(url => url.includes("/batch?")).length)).toBe(1);
  assert.equal(await worker.evaluate(() => axccTestBibliographies.length), 1);
  assert.equal(await worker.evaluate(() => axccTestRequests.filter(url => url.includes("ARXIV%3A2601.16163")).length), 1);
  await preloadPopup.reload();
  await expect(preloadPopup.locator("#preload-references")).toBeChecked();
  await preloadPopup.locator("#preload-references").uncheck();
  await expect(preloadPopup.locator("#status")).toContainText("References load when you open their cards");
  await preloadPopup.screenshot({ path: join(outputDir, "loading-options.png"), scale: "css", clip: { x: 0, y: 0, width: 330, height: 620 } });
  await preloadPopup.close();
  await page.bringToFront();

  await reset("busy");
  await expect(main).toContainText("Semantic Scholar is rate-limited");
  await openCitation();
  await expect(hover).toContainText("Semantic Scholar is rate-limited");
  await expect(hover.getByRole("link", { name: "Google Scholar" })).toHaveAttribute("href", /scholar\.google\.com\/scholar\?q=/);
  await expect(hover).toContainText("Retrying automatically");
  await page.screenshot({ path: join(outputDir, "native-automatic-retry.png"), scale: "css" });
  await worker.evaluate(() => { globalThis.axccTestMode = "success"; });
  await expect(hover).toContainText("1,234 citations");
  await main.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(main).toContainText("412 citations");

  await openCitation();
  await expect(hover).toContainText("1,234 citations");
  const linkedPaperPromise = page.waitForEvent("popup");
  await page.locator(".absolute.z-50").getByRole("link", { name: "Cosmos World Foundation Model Platform for Physical AI", exact: true }).click();
  const linkedPaper = await linkedPaperPromise;
  await expect(linkedPaper.locator(".axcc-paper-count")).toContainText("1,234 citations");
  await linkedPaper.close();
  await page.getByRole("link", { name: "Abstract", exact: true }).click();
  await page.locator('a[href="/abs/2303.04137"]').first().click();
  await expect(page).toHaveURL(/\/abs\/2303\.04137/);
  await expect(main).toHaveAttribute("data-axcc-paper-id", "2303.04137");
  await expect(main).toContainText("1,234 citations");
  await page.goBack();
  await expect(main).toHaveAttribute("data-axcc-paper-id", "2601.16163");
  await expect(main).toContainText("412 citations");
  await page.getByRole("link", { name: "Abstract", exact: true }).click();
  await expect(main).not.toHaveClass(/axcc-paper-reader/);

  const popup = await context.newPage();
  await popup.goto(new URL("popup.html", worker.url()).href);
  await expect(popup.locator("#preload-references")).not.toBeChecked();
  await popup.locator("#enabled").uncheck();
  await expect(main).toHaveCount(0);
  await popup.locator("#enabled").check();
  await expect(main).toContainText("412 citations");
  await popup.locator("#api-key").fill("bad-key");
  await popup.getByRole("button", { name: "Save & test", exact: true }).click();
  await expect(popup.locator("#status")).toContainText("Key rejected");
  assert.equal((await worker.evaluate(() => chrome.storage.local.get("semanticScholarApiKey"))).semanticScholarApiKey, undefined);
  await popup.locator("#api-key").fill("good-key");
  await popup.getByRole("button", { name: "Save & test", exact: true }).click();
  await expect(popup.locator("#status")).toContainText("S2 key works");
  await expect(main).toContainText("412 citations");
  await popup.getByRole("button", { name: "Clear cache", exact: true }).click();
  await expect(popup.locator("#status")).toContainText("Cleared");
  await expect(main).toContainText("412 citations");
  await popup.screenshot({ path: join(outputDir, "fixture-popup.png"), scale: "css" });
  await popup.close();

  await reset("missing");
  await expect(main).toContainText("No Semantic Scholar count available");
  await expect(main.getByRole("link", { name: "Google Scholar" })).toBeVisible();
  await expect(main.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await page.setViewportSize({ width: 720, height: 900 });
  await page.screenshot({ path: join(outputDir, "fixture-missing-narrow.png"), scale: "css" });
  const bounds = await main.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 720 && bounds.y + bounds.height <= 900);
  await reset("success");
  await expect(main).toContainText("412 citations");
  await page.getByRole("link", { name: "Paper", exact: true }).click();
  await expect(main).toHaveClass(/axcc-paper-reader/);
  await expect(main).toBeVisible();
  await page.screenshot({ path: join(outputDir, "fixture-reader-narrow.png"), scale: "css" });
  const readerBounds = await main.boundingBox();
  assert.ok(readerBounds && readerBounds.x >= 0 && readerBounds.x + readerBounds.width <= 720);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('a[href="/"]').first().click();
  await expect(main).toHaveCount(0);
  console.log("Chrome integration passed: on-demand request counts, optional preloading, saved loading preferences, counts, hover stability, retries, navigation, enable switch, key validation, cache refresh, missing records, narrow layouts.");
}

if (typeof process !== "undefined" && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { chromium } = createRequire(import.meta.url)("playwright");
  const extensionDir = fileURLToPath(new URL(".", import.meta.url));
  const profileDir = await mkdtemp(join(tmpdir(), "axcc-e2e-"));
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      headless: false,
      viewport: { width: 1440, height: 1000 },
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, "--no-first-run", "--no-default-browser-check"],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    await installFixture(worker);
    await verifyExtension(context, worker, context.pages()[0], join(extensionDir, "test-results"));
    const summaryPage = await context.newPage();
    await verifySummaryCards(context, worker, summaryPage, join(extensionDir, "test-results"), createRequire(import.meta.url)("playwright/test").expect);
    await summaryPage.close();
    await verifyHoverRetries(context, worker, await context.newPage(), join(extensionDir, "test-results"), createRequire(import.meta.url)("playwright/test").expect);
    await verifyBookmarkCards(context, worker, await context.newPage(), join(extensionDir, "test-results"), createRequire(import.meta.url)("playwright/test").expect);
  } finally {
    await context?.close();
    await rm(profileDir, { recursive: true, force: true });
  }
}
