import assert from "node:assert/strict";
import { join } from "node:path";

const fixture = `<!doctype html><html><head><meta charset="utf-8"><title>Citation retry check</title>
<style>
body{font:16px system-ui;margin:40px;color:#25232a;background:#fbfafc}h1{max-width:800px}
button{font:inherit;cursor:pointer;padding:8px 12px;margin:8px 8px 8px 0}
.absolute{position:absolute}.z-50{z-index:50}[hidden]{display:none!important}
#reference-card{top:320px;left:40px;width:520px;padding:24px;border:1px solid #ddd;border-radius:16px;background:white}
.line-clamp-4{display:block;color:inherit;font-weight:600;margin-bottom:12px}
</style></head><body>
<h1>Cosmos Policy: Fine-Tuning Video Models for Visuomotor Control and Planning</h1>
<p>Open a reference card to request its citation count.</p>
<button id="citation">Open reference</button>
<div id="reference-card" class="absolute z-50" hidden>
<a class="line-clamp-4" href="https://www.alphaxiv.org/abs/2501.03575">Cosmos World Foundation Model Platform for Physical AI</a>
<p>Reference details remain available while requesting a citation count.</p>
<button id="close-reference">Close reference</button>
<button id="change-reference">Change reference</button>
<button id="remove-reference">Remove card</button>
</div>
<script>
const card = document.querySelector('#reference-card');
const trigger = document.querySelector('#citation');
trigger.onmouseenter = trigger.onclick = () => { card.hidden = false; };
document.querySelector('#close-reference').onclick = () => { card.hidden = true; };
document.querySelector('#change-reference').onclick = () => {
  const link = card.querySelector('a.line-clamp-4');
  link.href = 'https://www.alphaxiv.org/abs/2210.02747';
  link.textContent = 'Flow Matching for Generative Modeling';
};
document.querySelector('#remove-reference').onclick = () => { card.remove(); };
</script></body></html>`;

export async function verifyHoverRetries(context, worker, page, outputDir, assertions) {
  const expect = assertions.configure({ timeout: 8_000 });
  page.setDefaultTimeout(10_000);
  await page.route("https://www.alphaxiv.org/abs/2601.16163", route => route.fulfill({ contentType: "text/html", body: fixture }));
  const row = page.locator("#reference-card .axcc-citation-count");
  const calls = () => worker.evaluate(() => axccTestReferenceTimes.length);
  const seed = async (mode, failures = 0, retryAfter = 0) => {
    await page.goto("about:blank");
    await worker.evaluate(async ({ mode, failures, retryAfter }) => {
      globalThis.axccTestMode = mode;
      globalThis.axccTestReferenceFailures = failures;
      globalThis.axccTestReferenceRetryAfter = retryAfter;
      globalThis.axccTestReferenceTimes = [];
      globalThis.axccTestRequests = [];
      await chrome.storage.local.clear();
    }, { mode, failures, retryAfter });
    await page.bringToFront();
    await page.goto("https://www.alphaxiv.org/abs/2601.16163");
    await expect(page.locator(".axcc-paper-count")).toContainText("412 citations");
    await page.getByRole("button", { name: "Open reference", exact: true }).click();
  };
  const stableForCycle = async () => {
    const before = await calls();
    await page.waitForTimeout(1_600);
    assert.equal(await calls(), before);
  };

  await seed("success", 3);
  await expect(row).toContainText("Retrying automatically");
  await page.mouse.move(1000, 500);
  await expect(row).toContainText("1,234 citations");
  assert.equal(await calls(), 4);
  const times = await worker.evaluate(() => axccTestReferenceTimes);
  for (let index = 1; index < times.length; index++) assert.ok(times[index] - times[index - 1] >= 1_000);
  await stableForCycle();
  await page.screenshot({ path: join(outputDir, "automatic-retry-success.png"), scale: "css" });

  await seed("success", 1, 2);
  await expect(row).toContainText("Retrying automatically");
  await expect(row).toContainText("1,234 citations");
  const delayed = await worker.evaluate(() => axccTestReferenceTimes);
  assert.equal(delayed.length, 2);
  assert.ok(delayed[1] - delayed[0] >= 2_000);

  await seed("busy-reference");
  await expect(row).toContainText("Retrying automatically");
  await page.screenshot({ path: join(outputDir, "automatic-retry-waiting.png"), scale: "css" });
  await page.getByRole("button", { name: "Close reference", exact: true }).click();
  await stableForCycle();
  const paused = await calls();
  await page.getByRole("button", { name: "Open reference", exact: true }).click();
  await expect.poll(calls).toBeGreaterThan(paused);
  await page.getByRole("button", { name: "Close reference", exact: true }).click();

  await seed("busy-reference");
  await expect(row).toContainText("Retrying automatically");
  await page.getByRole("button", { name: "Remove card", exact: true }).click();
  await stableForCycle();

  await seed("busy-reference");
  await expect(row).toContainText("Retrying automatically");
  await page.getByRole("button", { name: "Change reference", exact: true }).click();
  await expect(row).toContainText("3,654 citations");
  await stableForCycle();

  for (const mode of ["auth-reference", "missing-reference"]) {
    await seed(mode);
    await expect(row).toContainText(mode === "auth-reference" ? "key rejected" : "No Semantic Scholar count available");
    await expect(row).not.toContainText("Retrying automatically");
    await stableForCycle();
  }

  await seed("busy-reference");
  await expect(row).toContainText("Retrying automatically");
  const visibilitySession = await context.newCDPSession(page);
  const worlds = [];
  visibilitySession.on("Runtime.executionContextCreated", event => worlds.push(event.context));
  await visibilitySession.send("Runtime.enable");
  const extensionWorld = worlds.find(world => world.name === "alphaXiv Citation Counts");
  assert.ok(extensionWorld);
  await visibilitySession.send("Runtime.evaluate", {
    contextId: extensionWorld.id,
    expression: 'Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange"));',
  });
  await stableForCycle();
  const backgroundCalls = await calls();
  await visibilitySession.send("Runtime.evaluate", {
    contextId: extensionWorld.id,
    expression: 'delete document.hidden; document.dispatchEvent(new Event("visibilitychange"));',
  });
  await visibilitySession.detach();
  await expect.poll(calls).toBeGreaterThan(backgroundCalls);
  await page.getByRole("button", { name: "Close reference", exact: true }).click();

  await seed("busy-reference");
  await expect(row).toContainText("Retrying automatically");
  const popup = await context.newPage();
  await popup.goto(new URL("popup.html", worker.url()).href);
  await popup.locator("#enabled").uncheck();
  await expect(row).toHaveCount(0);
  await popup.close();
  await page.bringToFront();
  await stableForCycle();
  console.log("Automatic retry checks passed: recovery, request pacing, server delays, hidden and removed cards, reference changes, permanent results, document visibility, disabled extension.");
}
