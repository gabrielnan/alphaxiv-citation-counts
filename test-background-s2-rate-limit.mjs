import assert from "node:assert/strict";

const store = Object.create(null);
const requestTimes = [];
let messageListener;

globalThis.fetch = async (input, init = {}) => {
  assert.match(String(input), /^https:\/\/api\.semanticscholar\.org\//);
  assert.ok(init.headers?.["x-api-key"]);
  requestTimes.push(Date.now());
  return new Response(
    JSON.stringify({
      paperId: "flow-matching-paper-id",
      title: "Flow Matching for Generative Modeling",
      citationCount: 3654,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
};

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (key === null) return { ...store };
        if (typeof key === "string") return { [key]: store[key] };
        return { ...(key || {}) };
      },
      async set(values) {
        Object.assign(store, values);
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
      },
    },
  },
  runtime: {
    onMessage: {
      addListener(listener) {
        messageListener = listener;
      },
    },
  },
};

await import("./background.js");

function send(message) {
  return new Promise((resolve) => {
    assert.equal(messageListener(message, {}, resolve), true);
  });
}

const responses = await Promise.all([
  send({ type: "axcc:validate-s2-key", apiKey: "first-key" }),
  send({ type: "axcc:validate-s2-key", apiKey: "second-key" }),
]);

assert.ok(responses.every((response) => response.ok));
assert.equal(requestTimes.length, 2);
assert.ok(
  requestTimes[1] - requestTimes[0] >= 1_000,
  `Semantic Scholar calls were only ${requestTimes[1] - requestTimes[0]}ms apart`
);

console.log("Semantic Scholar shared one-request-per-second queue test passed.");
