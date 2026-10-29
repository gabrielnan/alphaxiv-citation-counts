import assert from "node:assert/strict";
import { join } from "node:path";

export const bookmarkFixture = `<!doctype html><html><head><meta charset="utf-8"><title>Bookmark citation checks</title>
<style>
*{box-sizing:border-box}body{font:14px system-ui;margin:0;color:#252525;background:#fff}
header{padding:24px;border-bottom:1px solid #ddd}h1{font-size:20px;margin:0 0 12px}
button{font:inherit;padding:6px 10px;margin:4px;cursor:pointer}a{color:inherit;text-decoration:none}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:20px;padding:24px;max-width:1000px}
.card{min-width:0}.thumbnail{height:136px;border:1px solid #ddd;border-radius:10px;display:block;background:#fafafa;overflow:hidden}
.thumbnail img{width:100%;height:100%;object-fit:contain}.line-clamp-2{font-weight:600;line-height:1.4;margin:8px 0 0}
.date{color:#666;font-size:11px;margin-top:4px}.offscreen{margin-top:1200px}[hidden]{display:none!important}
</style></head><body><header><h1>Library / Robotics</h1>
<button id="folder">Switch folder</button><button id="hide">Hide first card</button>
<button id="change">Replace first paper</button><button id="remove-badge">Redraw title</button>
<button id="paper">Read first paper</button>
</header><main><div class="grid" id="folder-a">
<article class="card" id="first"><a class="thumbnail" href="https://www.alphaxiv.org/abs/2601.16163"><img alt="Paper preview"></a>
<a class="line-clamp-2" id="first-title" href="https://www.alphaxiv.org/abs/2601.16163">Cosmos Policy: Fine-Tuning Video Models</a><div class="date">Added Oct 27, 2026</div></article>
<a class="card" id="whole-link" href="https://www.alphaxiv.org/abs/2210.02747"><div class="thumbnail"><img alt="Paper preview"></div>
<div class="line-clamp-2">Flow Matching for Generative Modeling</div><div class="date">Added Oct 27, 2026</div></a>
<article class="card" id="image-link"><a class="thumbnail" href="https://www.alphaxiv.org/abs/2501.03575v2"><img alt="Paper preview"></a>
<h3 class="line-clamp-2">Cosmos World Foundation Model Platform</h3><div class="date">Added Oct 27, 2026</div></article>
<div class="card" id="nested-title"><a class="thumbnail" href="https://www.alphaxiv.org/pdf/2508.08241"><img alt="Paper preview"></a>
<a href="https://www.alphaxiv.org/abs/2508.08241"><span class="line-clamp-2">BeyondMimic: Versatile Humanoid Control</span></a><div class="date">Added Oct 27, 2026</div></div>
</div><div class="grid" id="folder-b" hidden><article class="card"><a href="https://www.alphaxiv.org/abs/2210.02747"><h3 class="line-clamp-2">Flow Matching for Generative Modeling</h3></a></article></div>
<div class="grid offscreen" id="offscreen"><article class="card"><a class="line-clamp-2" href="https://www.alphaxiv.org/abs/2503.11801">Diffuse-CLoC: Guided Diffusion for Physics-based Character Control</a></article></div>
</main><script>
document.querySelector('#folder').onclick=()=>{
 document.querySelector('#folder-a').hidden=!document.querySelector('#folder-a').hidden;
 document.querySelector('#folder-b').hidden=!document.querySelector('#folder-b').hidden;
 history.pushState({},'',document.querySelector('#folder-b').hidden?'?folder=a':'?folder=b');
};
document.querySelector('#hide').onclick=()=>{document.querySelector('#first').hidden=!document.querySelector('#first').hidden;};
document.querySelector('#change').onclick=()=>{
 const link=document.querySelector('#first-title');
 link.href='https://www.alphaxiv.org/abs/2503.11801';
 link.textContent='Diffuse-CLoC: Guided Diffusion for Physics-based Character Control';
 document.querySelector('#first .thumbnail').href=link.href;
};
document.querySelector('#remove-badge').onclick=()=>{document.querySelector('#first-title').nextElementSibling.remove();};
document.querySelector('#paper').onclick=()=>{history.pushState({},'',new URL(document.querySelector('#first-title').href).pathname);dispatchEvent(new PopStateEvent('popstate'));};
</script></body></html>`;

export async function verifyBookmarkCards(context, worker, page, outputDir, assertions) {
  const expect = assertions.configure({ timeout: 12_000 });
  await page.route("https://www.alphaxiv.org/bookmarks**", route => route.fulfill({ contentType: "text/html", body: bookmarkFixture }));
  await worker.evaluate(async () => {
    await chrome.storage.local.clear();
    globalThis.axccTestMode = "success";
    globalThis.axccTestRequests = [];
  });
  await page.bringToFront();
  await page.goto("https://www.alphaxiv.org/bookmarks?folder=a");
  const rows = page.locator(".axcc-bookmark-count");
  for (const [card, count] of [["#first", "412"], ["#whole-link", "3,654"], ["#image-link", "1,234"], ["#nested-title", "731"]]) {
    await expect(page.locator(`${card} .axcc-bookmark-count`)).toContainText(`${count} citations`);
  }
  await expect(rows).toHaveCount(4);
  assert.equal(await worker.evaluate(() => axccTestRequests.length), 4);
  assert.equal(await page.locator("a a").count(), 0);
  await expect(page.locator("#offscreen .axcc-bookmark-count")).toHaveCount(0);
  await page.screenshot({ path: join(outputDir, "bookmarks-counts.png"), scale: "css" });
  await page.getByRole("button", { name: "Redraw title", exact: true }).click();
  await expect(page.locator("#first .axcc-bookmark-count")).toContainText("412 citations");
  assert.equal(await worker.evaluate(() => axccTestRequests.length), 4);
  await page.getByRole("button", { name: "Switch folder", exact: true }).click();
  await expect(page.locator("#folder-b .axcc-bookmark-count")).toContainText("3,654 citations");
  assert.equal(await worker.evaluate(() => axccTestRequests.length), 4);
  await page.getByRole("button", { name: "Switch folder", exact: true }).click();
  await page.getByRole("button", { name: "Replace first paper", exact: true }).click();
  await expect(page.locator("#first .axcc-bookmark-count")).toContainText("42 citations");
  await expect(page.locator("#first .axcc-bookmark-count")).toHaveCount(1);
  await page.locator("#offscreen").scrollIntoViewIfNeeded();
  await expect(page.locator("#offscreen .axcc-bookmark-count")).toContainText("42 citations");
  assert.equal(await worker.evaluate(() => axccTestRequests.length), 5);
  await page.setViewportSize({ width: 720, height: 900 });
  await page.getByRole("button", { name: "Switch folder", exact: true }).scrollIntoViewIfNeeded();
  const bounds = await rows.first().boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 720);
  await page.screenshot({ path: join(outputDir, "bookmarks-narrow.png"), scale: "css" });
  const popup = await context.newPage();
  await popup.goto(new URL("popup.html", worker.url()).href);
  await popup.locator("#enabled").uncheck();
  await expect(rows).toHaveCount(0);
  await popup.locator("#enabled").check();
  await expect(page.locator("#first .axcc-bookmark-count")).toContainText("42 citations");
  await popup.close();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const beforePaper = await worker.evaluate(() => axccTestRequests.length);
  await page.getByRole("button", { name: "Read first paper", exact: true }).click();
  await expect(rows).toHaveCount(0);
  await expect(page.locator(".axcc-paper-count")).toContainText("42 citations");
  assert.equal(await worker.evaluate(() => axccTestRequests.length), beforePaper);
  console.log("Bookmark checks passed: title layouts, visible cards, cache reuse across folders and paper pages, replaced paper links, restored badges, extension toggle, narrow layout.");
}
