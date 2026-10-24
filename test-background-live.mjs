import assert from "node:assert/strict";

const store = { semanticScholarApiKey: process.env.SEMANTIC_SCHOLAR_API_KEY || "" };
let listener;
const nativeFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = (input, init) => {
  assert.equal(new URL(String(input)).hostname, "api.semanticscholar.org");
  requests++;
  return nativeFetch(input, init);
};
globalThis.chrome = {
  storage: { local: {
    async get(key) { return key === null ? { ...store } : { [key]: store[key] }; },
    async set(values) { Object.assign(store, values); },
    async remove(keys) { for (const key of [].concat(keys)) delete store[key]; },
  } },
  runtime: { onMessage: { addListener(fn) { listener = fn; } } },
};
await import("./background.js");
const send = message => new Promise(resolve => listener(message, {}, resolve));
const message = { type: "axcc:lookup-paper", paperId: "2210.02747v1" };
const response = await send(message);
if (!store.semanticScholarApiKey && ["s2_busy", "s2_unavailable"].includes(response.error)) {
  console.log(`Live lookup unavailable (${response.error}); set SEMANTIC_SCHOLAR_API_KEY to test keyed access.`);
} else {
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.result.source, "Semantic Scholar");
  assert.match(response.result.title, /flow matching for generative modeling/i);
  assert.ok(response.result.citationCount > 0);
  const before = requests;
  assert.deepEqual(await send(message), response);
  assert.equal(requests, before);
  console.log(`Live paper count passed: ${response.result.citationCount} citations from Semantic Scholar; repeated lookup used the cache.`);
}
