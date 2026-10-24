import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { referenceKey } from "./shared.mjs";

const paper = {
  paperId: "flow-matching-paper",
  title: "Flow Matching for Generative Modeling",
  year: 2023,
  citationCount: 3654,
  externalIds: { ArXiv: "2210.02747" },
  authors: [{ name: "Yaron Lipman" }],
};
const reference = "[1] Yaron Lipman et al. 2023. Flow Matching for Generative Modeling. ICLR.";
const exactReference = `${reference} arXiv:2210.02747`;
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "Content-Type": "application/json" },
});

let moduleId = 0;
async function harness(respond, initialStore = {}) {
  const store = { ...initialStore };
  const calls = [];
  let listener;
  globalThis.chrome = {
    storage: { local: {
      async get(key) {
        if (key === null) return { ...store };
        if (typeof key === "string") return { [key]: store[key] };
        return { ...key, ...Object.fromEntries(Object.keys(key || {}).filter(k => k in store).map(k => [k, store[k]])) };
      },
      async set(values) { Object.assign(store, values); },
      async remove(keys) { for (const key of [].concat(keys)) delete store[key]; },
    } },
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.ok(["api.semanticscholar.org", "www.alphaxiv.org"].includes(url.hostname), url.href);
    calls.push({ url, init });
    return respond(url, init, calls);
  };
  await import(`./background.js?test=${moduleId++}`);
  return {
    store, calls,
    send: message => new Promise(resolve => { listener(message, {}, resolve); }),
  };
}

test("title lookups use Semantic Scholar, cache successful matches, preserve zero counts", async () => {
  const h = await harness(url => {
    assert.equal(url.pathname, "/graph/v1/paper/search/match");
    return json({ data: [{ ...paper, citationCount: 0 }] });
  });
  const message = { type: "axcc:lookup", reference, hrefs: [] };
  const response = await h.send(message);
  assert.equal(response.result.source, "Semantic Scholar");
  assert.equal(response.result.citationCount, 0);
  assert.deepEqual(await h.send(message), response);
  assert.equal(h.calls.length, 1);
});

test("current paper counts use exact versionless arXiv IDs without a bibliography request", async () => {
  const h = await harness(url => {
    assert.equal(decodeURIComponent(url.pathname), "/graph/v1/paper/ARXIV:2210.02747");
    return json(paper);
  });
  const message = { type: "axcc:lookup-paper", paperId: "2210.02747v3" };
  const responses = await Promise.all([h.send(message), h.send(message)]);
  assert.ok(responses.every(response => response.result.citationCount === 3654));
  assert.equal(h.calls.length, 1);
  assert.deepEqual(await h.send({ type: "axcc:lookup-paper", paperId: "../invalid" }), {
    ok: false, error: "invalid_paper", result: null,
  });
});

test("exact reference preloads provide cached hover counts", async () => {
  const h = await harness((url, init) => {
    if (url.hostname === "www.alphaxiv.org") return new Response(`References\n${exactReference}`);
    assert.equal(url.pathname, "/graph/v1/paper/batch");
    assert.deepEqual(JSON.parse(init.body).ids, ["ARXIV:2210.02747"]);
    return json([paper]);
  }, { axccPreloadReferences: true });
  const preload = await h.send({ type: "axcc:prefetch-paper", paperId: "2601.16163" });
  assert.equal(preload.referenceCount, 1);
  const response = await h.send({ type: "axcc:lookup", reference, sourcePaperId: "2601.16163" });
  assert.equal(response.result.citationCount, 3654);
  assert.equal(h.calls.length, 2);
});

test("preload rate limits remain retryable and do not prevent direct exact lookups", async () => {
  const h = await harness(url => {
    if (url.hostname === "www.alphaxiv.org") return new Response(`References\n${exactReference}`);
    if (url.pathname.endsWith("/batch")) return json({}, 429);
    return json(paper);
  }, { axccPreloadReferences: true });
  assert.deepEqual(await h.send({ type: "axcc:prefetch-paper", paperId: "2601.16163" }), {
    ok: false, error: "s2_busy",
  });
  assert.deepEqual(h.store, { axccPreloadReferences: true });
  const response = await h.send({ type: "axcc:lookup", reference, sourcePaperId: "2601.16163", hrefs: ["https://www.alphaxiv.org/pdf/2210.02747"] });
  assert.equal(response.result.source, "Semantic Scholar");
  assert.equal(decodeURIComponent(h.calls.at(-1).url.pathname), "/graph/v1/paper/ARXIV:2210.02747");
});

test("reference preloading requires an explicit saved opt-in", async () => {
  for (const settings of [{}, { axccPreloadReferences: false }, { axccEnabled: false, axccPreloadReferences: true }]) {
    const h = await harness(() => assert.fail("Preloading requested a network lookup"), settings);
    assert.deepEqual(await h.send({ type: "axcc:prefetch-paper", paperId: "2601.16163" }), {
      ok: false, error: "preload_disabled",
    });
    assert.equal(h.calls.length, 0);
  }
});

test("disabling preloading prevents queued batch requests", async () => {
  let releaseLookup;
  let lookupStarted;
  let bibliographyFetched;
  const lookupReady = new Promise(resolve => { lookupStarted = resolve; });
  const bibliographyReady = new Promise(resolve => { bibliographyFetched = resolve; });
  const pendingLookup = new Promise(resolve => { releaseLookup = resolve; });
  const h = await harness(async url => {
    if (url.hostname === "www.alphaxiv.org") {
      bibliographyFetched();
      return new Response(`References\n${exactReference}`);
    }
    assert.ok(!url.pathname.endsWith("/batch"));
    lookupStarted();
    await pendingLookup;
    return json(paper);
  }, { axccPreloadReferences: true });
  const lookup = h.send({ type: "axcc:lookup-paper", paperId: "2210.02747" });
  await lookupReady;
  const preload = h.send({ type: "axcc:prefetch-paper", paperId: "2601.16163" });
  await bibliographyReady;
  h.store.axccPreloadReferences = false;
  releaseLookup();
  assert.equal((await lookup).ok, true);
  assert.deepEqual(await preload, { ok: false, error: "preload_disabled" });
  assert.equal(h.calls.length, 2);
});

test("disabling preloading stops keyed batch retries after a rate limit", async () => {
  const h = await harness(url => {
    if (url.hostname === "www.alphaxiv.org") return new Response(`References\n${exactReference}`);
    assert.equal(url.pathname, "/graph/v1/paper/batch");
    h.store.axccPreloadReferences = false;
    return json({}, 429);
  }, { axccPreloadReferences: true, semanticScholarApiKey: "saved-key" });
  assert.deepEqual(await h.send({ type: "axcc:prefetch-paper", paperId: "2601.16163" }), {
    ok: false, error: "preload_disabled",
  });
  assert.equal(h.calls.length, 2);
  assert.equal(Object.keys(h.store).filter(key => key.startsWith("axcc:")).length, 0);
});

test("legacy cached counts are ignored and removed by clear cache", async () => {
  const h = await harness(() => json(paper), {
    [`axcc:v3:lookup:${referenceKey("arXiv:2210.02747")}`]: {
      savedAt: Date.now(), result: { citationCount: 95, source: "OpenAlex fallback" },
    },
    "axcc:v3:paper:2601.16163": { savedAt: Date.now(), references: [] },
    semanticScholarApiKey: "saved-key",
  });
  assert.equal((await h.send({ type: "axcc:lookup-paper", paperId: "2210.02747" })).result.citationCount, 3654);
  assert.equal(h.calls.length, 1);
  await h.send({ type: "axcc:clear-cache" });
  assert.deepEqual(h.store, { semanticScholarApiKey: "saved-key" });
});

test("transient errors and absent matches are retried on subsequent requests", async () => {
  for (const status of [429, 503, 404]) {
    const h = await harness((_url, _init, calls) => calls.length === 1 ? json({}, status) : json(paper));
    const message = { type: "axcc:lookup-paper", paperId: "2210.02747" };
    const first = await h.send(message);
    if (status === 404) assert.deepEqual(first, { ok: true, result: null });
    else assert.equal(first.error, status === 429 ? "s2_busy" : "s2_unavailable");
    assert.equal(Object.keys(h.store).length, 0);
    assert.equal((await h.send(message)).result.citationCount, 3654);
  }
});

test("key validation distinguishes rejected keys and successful access", async () => {
  const h = await harness((_url, init) => init.headers["x-api-key"] === "good-key" ? json(paper) : json({}, 403));
  assert.deepEqual(await h.send({ type: "axcc:validate-s2-key", apiKey: "bad-key" }), { ok: false, error: "s2_auth" });
  assert.equal((await h.send({ type: "axcc:validate-s2-key", apiKey: "good-key" })).citationCount, 3654);
});

test("keyed requests retry rate limits and server errors within the shared queue", async () => {
  const h = await harness((_url, init, calls) => {
    assert.equal(init.headers["x-api-key"], "saved-key");
    return calls.length < 3 ? json({}, calls.length === 1 ? 429 : 503) : json(paper);
  }, { semanticScholarApiKey: "saved-key" });
  assert.equal((await h.send({ type: "axcc:lookup-paper", paperId: "2210.02747" })).result.citationCount, 3654);
  assert.equal(h.calls.length, 3);
});

test("hover lookups return rate limits promptly with the requested retry delay", async () => {
  const h = await harness(() => new Response("{}", { status: 429, headers: { "Retry-After": "2" } }), {
    semanticScholarApiKey: "saved-key",
  });
  assert.deepEqual(await h.send({ type: "axcc:lookup", reference, hrefs: ["https://arxiv.org/abs/2210.02747"] }), {
    ok: false, error: "s2_busy", result: null, retryAfterMs: 2000,
  });
  assert.equal(h.calls.length, 1);
});

test("the shared request queue observes a server retry delay", async () => {
  const times = [];
  const h = await harness(() => {
    times.push(Date.now());
    return times.length === 1
      ? new Response("{}", { status: 429, headers: { "Retry-After": "2" } })
      : json(paper);
  });
  const message = { type: "axcc:lookup", reference, hrefs: ["https://arxiv.org/abs/2210.02747"] };
  assert.equal((await h.send(message)).retryAfterMs, 2000);
  assert.equal((await h.send(message)).result.citationCount, 3654);
  assert.ok(times[1] - times[0] >= 2000);
});

test("extension requests permission for the supported citation provider", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", import.meta.url)));
  assert.deepEqual(manifest.host_permissions, [
    "https://api.semanticscholar.org/*",
    "https://alphaxiv.org/*",
    "https://www.alphaxiv.org/*",
  ]);
});
