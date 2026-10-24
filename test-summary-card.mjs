import assert from "node:assert/strict";
import { join } from "node:path";

export async function verifySummaryCards(context, worker, page, outputDir, assertions) {
  const expect = assertions.configure({ timeout: 10_000 });
  page.setDefaultTimeout(15_000);
  await worker.evaluate(async () => {
    await chrome.storage.local.clear();
    globalThis.axccTestMode = "success";
    globalThis.axccTestRequests = [];
    globalThis.axccTestBibliographies = [];
  });
  await page.bringToFront();
  await page.goto("https://www.alphaxiv.org/abs/2508.08241", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".axcc-paper-count")).toContainText("731 citations");
  assert.equal(await worker.evaluate(() => axccTestRequests.length), 1);
  const trigger = page.getByRole("link", { name: "Diffuse-CLoC", exact: true });
  const card = page.locator(".fixed.z-50").filter({ hasText: "Diffuse-CLoC: Guided Diffusion" });
  const row = card.locator(".axcc-citation-count");
  const openCard = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.mouse.move(10, 10);
      await card.waitFor({ state: "hidden" });
      await trigger.hover();
      try {
        await card.waitFor({ state: "visible", timeout: 3_000 });
        return;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
  };
  await openCard();
  await expect(card).toBeVisible();
  await expect(row).toContainText("42 citations");
  await expect(row).toContainText("Semantic Scholar");
  await expect(row.locator("a.axcc-result")).toHaveAttribute("href", "https://www.semanticscholar.org/paper/diffuse-cloc-id");
  const requests = await worker.evaluate(() => axccTestRequests);
  assert.equal(requests.length, 2);
  assert.ok(decodeURIComponent(requests[1]).includes("ARXIV:2503.11801"));
  assert.equal(await worker.evaluate(() => axccTestBibliographies.length), 0);
  await page.waitForTimeout(1_200);
  await expect(row).toContainText("42 citations");
  assert.equal(await worker.evaluate(() => axccTestRequests.length), 2);
  await page.screenshot({ path: join(outputDir, "summary-diffuse-cloc.png"), scale: "css" });

  await page.mouse.move(10, 10);
  await expect(card).toHaveCount(0);
  await openCard();
  await expect(row).toContainText("42 citations");
  assert.equal(await worker.evaluate(() => axccTestRequests.length), 2);

  await worker.evaluate(async () => {
    globalThis.axccTestMode = "busy";
    const saved = await chrome.storage.local.get(null);
    await chrome.storage.local.remove(Object.keys(saved).filter(key => key.startsWith("axcc:")));
    await chrome.storage.local.set({ axccConfigRevision: Date.now() });
  });
  await expect(row).toContainText("Retrying automatically");
  await page.screenshot({ path: join(outputDir, "summary-diffuse-cloc-retrying.png"), scale: "css" });
  await worker.evaluate(() => { globalThis.axccTestMode = "success"; });
  await expect(row).toContainText("42 citations");
  await page.mouse.move(10, 10);
  await expect(card).toHaveCount(0);
  const closed = await worker.evaluate(() => axccTestRequests.length);
  await page.waitForTimeout(1_600);
  assert.equal(await worker.evaluate(() => axccTestRequests.length), closed);
  console.log("AI-summary hover checks passed on BeyondMimic: fixed-position Diffuse-CLoC card, exact paper lookup, stable counts, cache reuse, automatic recovery, closing the card.");
}
