import {
  extractIdentifiers,
  guessTitleFromReference,
  parseAlphaXivReferences,
  referenceKey,
  selectReference,
} from "./shared.mjs";

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const LOOKUP_CACHE_PREFIX = "axcc:v4:lookup:";
const PAPER_CACHE_PREFIX = "axcc:v4:paper:";
const LEGACY_CACHE_PREFIXES = [
  "axcc:v3:lookup:",
  "axcc:v3:paper:",
  "axcc:lookup:",
  "axcc:paper:",
  "axcc:v2:lookup:",
  "axcc:v2:paper:",
];
const SUCCESS_TTL = 7 * 24 * 60 * 60 * 1000;
const EMPTY_PAPER_TTL = 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 300;
const S2_TIMEOUT_MS = 5_000;
// Keyed Semantic Scholar access is limited to one request per second across all
// endpoints. A small safety margin avoids crossing the boundary due to jitter.
const S2_MIN_REQUEST_GAP_MS = 1_100;
const S2_MAX_KEYED_RETRIES = 2;
const PREFETCH_HOVER_WAIT_MS = 3_000;
const S2_BATCH_SIZE = 500;
const S2_FIELDS = [
  "paperId",
  "title",
  "year",
  "citationCount",
  "externalIds",
  "authors",
  "url",
].join(",");

const lookupInFlight = new Map();
const prefetchInFlight = new Map();
let semanticScholarQueue = Promise.resolve();
let lastSemanticScholarRequestAt = 0;
let semanticScholarBlockedUntil = 0;

class SemanticScholarUnavailableError extends Error {
  constructor(retryAfterMs = 0) {
    super("Semantic Scholar is temporarily unavailable");
    this.name = "SemanticScholarUnavailableError";
    this.retryAfterMs = retryAfterMs;
  }
}

class SemanticScholarAuthError extends Error {
  constructor() {
    super("Semantic Scholar API key rejected");
    this.name = "SemanticScholarAuthError";
  }
}

class SemanticScholarBusyError extends Error {
  constructor(retryAfterMs = 0) {
    super("Semantic Scholar is rate-limiting requests");
    this.name = "SemanticScholarBusyError";
    this.retryAfterMs = retryAfterMs;
  }
}

class PreloadDisabledError extends Error {}

async function requirePreloadEnabled() {
  const settings = await chrome.storage.local.get({ axccEnabled: true, axccPreloadReferences: false });
  if (!settings.axccEnabled || settings.axccPreloadReferences !== true) {
    throw new PreloadDisabledError();
  }
}

function errorCode(error) {
  if (error instanceof PreloadDisabledError) return "preload_disabled";
  if (error instanceof SemanticScholarAuthError) return "s2_auth";
  if (error instanceof SemanticScholarBusyError) return "s2_busy";
  if (error instanceof SemanticScholarUnavailableError) return "s2_unavailable";
  if (error?.name === "AbortError") return "lookup_timeout";
  return "lookup_failed";
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response) {
  const value = response.headers.get("retry-after");
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  return Math.max(0, Date.parse(value) - Date.now()) || 0;
}

function enqueueSemanticScholarRequest(operation) {
  const queued = semanticScholarQueue.then(async () => {
    const delay = Math.max(
      0,
      Math.max(lastSemanticScholarRequestAt + S2_MIN_REQUEST_GAP_MS, semanticScholarBlockedUntil) - Date.now()
    );
    if (delay) await wait(delay);
    lastSemanticScholarRequestAt = Date.now();
    return operation();
  });
  // A rejected request must not prevent later requests from reaching the queue.
  semanticScholarQueue = queued.catch(() => {});
  return queued;
}

function chunks(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

async function semanticScholar(
  path,
  { method = "GET", body, apiKeyOverride, retries, preload = false } = {}
) {
  const stored = apiKeyOverride === undefined
    ? await chrome.storage.local.get("semanticScholarApiKey")
    : null;
  const semanticScholarApiKey = apiKeyOverride === undefined
    ? String(stored?.semanticScholarApiKey || "").trim()
    : String(apiKeyOverride || "").trim();
  const maxRetries = retries ?? (semanticScholarApiKey ? S2_MAX_KEYED_RETRIES : 0);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response;
    try {
      response = await enqueueSemanticScholarRequest(async () => {
        if (preload) await requirePreloadEnabled();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), S2_TIMEOUT_MS);
        try {
          const response = await fetch(`${S2_BASE}/${path}`, {
            method,
            signal: controller.signal,
            headers: {
              ...(body ? { "content-type": "application/json" } : {}),
              ...(semanticScholarApiKey ? { "x-api-key": semanticScholarApiKey } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
          });
          if (response.status === 429 || response.status >= 500) {
            semanticScholarBlockedUntil = Math.max(semanticScholarBlockedUntil, Date.now() + retryAfterMs(response));
          }
          return response;
        } finally {
          clearTimeout(timeout);
        }
      });
    } catch (error) {
      if (error instanceof PreloadDisabledError) throw error;
      if (attempt === maxRetries) throw new SemanticScholarUnavailableError();
      await wait(1_000 * 2 ** attempt);
      continue;
    }

    if (response.status === 404) return null;
    if (response.status === 401 || response.status === 403) {
      throw new SemanticScholarAuthError();
    }
    if (response.status === 429) {
      if (attempt === maxRetries) throw new SemanticScholarBusyError(retryAfterMs(response));
      const retryAfter = Number(response.headers.get("retry-after"));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1_000
        : 1_000 * 2 ** attempt;
      await wait(Math.min(backoff, 8_000));
      continue;
    }
    if (response.status >= 500) {
      if (attempt === maxRetries) throw new SemanticScholarUnavailableError(retryAfterMs(response));
      await wait(1_000 * 2 ** attempt);
      continue;
    }
    if (!response.ok) throw new SemanticScholarUnavailableError();
    try {
      return await response.json();
    } catch {
      throw new SemanticScholarUnavailableError();
    }
  }
  throw new SemanticScholarUnavailableError();
}

async function validateSemanticScholarKey(apiKey) {
  const paper = await semanticScholar(
    `paper/${encodeURIComponent("ARXIV:2210.02747")}?fields=paperId,title,citationCount`,
    { apiKeyOverride: apiKey }
  );
  if (!paper?.paperId || !/flow matching for generative modeling/i.test(paper.title || "")) {
    throw new SemanticScholarUnavailableError();
  }
  return {
    keyed: Boolean(String(apiKey || "").trim()),
    matchedTitle: paper.title,
    citationCount: paper.citationCount ?? null,
  };
}

function semanticScholarId(identifier) {
  if (!identifier) return null;
  if (identifier.kind === "arxiv") return `ARXIV:${normalizePaperId(identifier.id)}`;
  if (identifier.kind === "doi") return `DOI:${normalizeDoi(identifier.id)}`;
  return null;
}

function citationResult(paper) {
  if (!paper?.title || !Number.isFinite(paper.citationCount) || paper.citationCount < 0) {
    return null;
  }
  return {
    citationCount: paper.citationCount,
    title: paper.title,
    url: paper.url || (paper.paperId
      ? `https://www.semanticscholar.org/paper/${paper.paperId}`
      : null),
    source: "Semantic Scholar",
  };
}

async function semanticScholarBatch(infos) {
  const requested = infos
    .map((info) => ({ info, id: semanticScholarId(info.identifier) }))
    .filter((item) => item.id);
  for (const batch of chunks(requested, S2_BATCH_SIZE)) {
    const response = await semanticScholar(`paper/batch?fields=${S2_FIELDS}`, {
      method: "POST",
      body: { ids: batch.map((item) => item.id) },
      preload: true,
    });
    if (!Array.isArray(response) || response.length !== batch.length) {
      throw new SemanticScholarUnavailableError();
    }
    for (let index = 0; index < batch.length; index++) {
      const paper = response[index];
      if (citationResult(paper)) batch[index].info.paper = paper;
    }
  }
}

async function semanticScholarByReference(reference, hrefs = [], retries) {
  const identifier = extractIdentifiers(reference, hrefs);
  const id = semanticScholarId(identifier);
  let paper;
  if (id) {
    paper = await semanticScholar(
      `paper/${encodeURIComponent(id)}?fields=${S2_FIELDS}`, { retries }
    );
  } else {
    const title = safeTitleQuery(guessTitleFromReference(reference));
    if (title.length < 12) return null;
    const response = await semanticScholar(
      `paper/search/match?query=${encodeURIComponent(title)}&fields=${S2_FIELDS}`, { retries }
    );
    paper = response?.data?.[0] || null;
  }
  if (!id && !selectReference([paper], reference)) return null;
  return citationResult(paper);
}

function normalizePaperId(value) {
  const id = String(value || "").trim().replace(/v\d+$/i, "");
  return /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})$/i.test(id) ? id : "";
}

function normalizeDoi(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .toLowerCase();
}

function compactPaper(paper) {
  return {
    paperId: paper.paperId,
    title: paper.title,
    year: paper.year,
    citationCount: paper.citationCount,
    externalIds: paper.externalIds,
    authors: (paper.authors || []).slice(0, 1),
    url: paper.url,
  };
}

function safeTitleQuery(title) {
  return String(title || "")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

async function fetchAlphaXivReferences(paperId) {
  const response = await fetch(
    `https://www.alphaxiv.org/abs/${paperId}.md`,
    { signal: AbortSignal.timeout(10_000) }
  );
  if (!response.ok) throw new Error(`alphaXiv HTTP ${response.status}`);
  return parseAlphaXivReferences(await response.text());
}

async function resolveBibliography(references) {
  const infos = references.map((reference) => ({
    identifier: extractIdentifiers(reference),
    paper: null,
  }));
  await semanticScholarBatch(infos);
  const papers = new Map();
  for (const info of infos) {
    if (info.paper?.paperId) papers.set(info.paper.paperId, compactPaper(info.paper));
  }
  return [...papers.values()];
}

function paperCacheKey(paperId) {
  return `${PAPER_CACHE_PREFIX}${normalizePaperId(paperId).toLowerCase()}`;
}

async function cachedPaper(paperId) {
  const key = paperCacheKey(paperId);
  const entry = (await chrome.storage.local.get(key))[key];
  if (!entry) return undefined;
  const ttl = entry.references?.length ? SUCCESS_TTL : EMPTY_PAPER_TTL;
  if (Date.now() - entry.savedAt > ttl) {
    await chrome.storage.local.remove(key);
    return undefined;
  }
  return { ...entry, cached: true };
}

async function prefetchPaper(paperId) {
  await requirePreloadEnabled();
  const id = normalizePaperId(paperId);
  if (!id) return { references: [], bibliographyCount: 0, complete: false, cached: false };
  const cached = await cachedPaper(id);
  if (cached !== undefined) return cached;
  if (prefetchInFlight.has(id)) return prefetchInFlight.get(id);

  const promise = (async () => {
    const bibliography = await fetchAlphaXivReferences(id);
    const references = bibliography.length ? await resolveBibliography(bibliography) : [];
    const entry = {
      savedAt: Date.now(),
      bibliographyCount: bibliography.length,
      complete: bibliography.length > 0,
      references,
    };
    await chrome.storage.local.set({ [paperCacheKey(id)]: entry });
    void pruneCache();
    return { ...entry, cached: false };
  })().finally(() => prefetchInFlight.delete(id));

  prefetchInFlight.set(id, promise);
  return promise;
}

async function fromPrefetchedPaper(sourcePaperId, reference) {
  if (!sourcePaperId) return { complete: false, result: null };
  const id = normalizePaperId(sourcePaperId);
  let paper = await cachedPaper(id);
  if (paper === undefined) {
    const pending = prefetchInFlight.get(id);
    if (pending) {
      let timer;
      try {
        paper = await Promise.race([
          pending,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), PREFETCH_HOVER_WAIT_MS);
          }),
        ]);
      } catch {
        paper = null;
      } finally {
        clearTimeout(timer);
      }
    }
  }
  if (!paper) return { complete: false, result: null };
  return {
    complete: paper.complete,
    result: citationResult(selectReference(paper.references, reference)),
  };
}

function lookupCacheKey(reference, hrefs) {
  return LOOKUP_CACHE_PREFIX + referenceKey(reference, hrefs);
}

async function cachedLookup(reference, hrefs) {
  const key = lookupCacheKey(reference, hrefs);
  const entry = (await chrome.storage.local.get(key))[key];
  if (!entry) return undefined;
  if (entry.result?.source !== "Semantic Scholar" || Date.now() - entry.savedAt > SUCCESS_TTL) {
    await chrome.storage.local.remove(key);
    return undefined;
  }
  return entry.result;
}

async function storeLookup(reference, hrefs, result) {
  await chrome.storage.local.set({
    [lookupCacheKey(reference, hrefs)]: { savedAt: Date.now(), result },
  });
  void pruneCache();
}

let pruning = false;
async function pruneCache() {
  if (pruning) return;
  pruning = true;
  try {
    const all = await chrome.storage.local.get(null);
    const entries = Object.entries(all)
      .filter(
        ([key]) => key.startsWith(LOOKUP_CACHE_PREFIX) || key.startsWith(PAPER_CACHE_PREFIX)
      )
      .sort((a, b) => (a[1]?.savedAt || 0) - (b[1]?.savedAt || 0));
    if (entries.length > MAX_CACHE_ENTRIES) {
      await chrome.storage.local.remove(
        entries.slice(0, entries.length - MAX_CACHE_ENTRIES).map(([key]) => key)
      );
    }
  } finally {
    pruning = false;
  }
}

async function performLookup(reference, hrefs, sourcePaperId, interactive) {
  const prefetched = await fromPrefetchedPaper(sourcePaperId, reference);
  if (prefetched.result) return prefetched.result;
  return semanticScholarByReference(reference, hrefs, interactive ? 0 : undefined);
}

async function lookup(reference, hrefs, sourcePaperId, interactive = false) {
  const cached = await cachedLookup(reference, hrefs);
  if (cached !== undefined) return cached;
  const key = lookupCacheKey(reference, hrefs);
  if (lookupInFlight.has(key)) return lookupInFlight.get(key);

  const promise = performLookup(reference, hrefs, sourcePaperId, interactive)
    .then(async (result) => {
      if (result) await storeLookup(reference, hrefs, result);
      return result;
    })
    .finally(() => lookupInFlight.delete(key));
  lookupInFlight.set(key, promise);
  return promise;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "axcc:validate-s2-key") {
    const apiKey = String(message.apiKey || "").trim().slice(0, 500);
    validateSemanticScholarKey(apiKey)
      .then((details) => sendResponse({ ok: true, ...details }))
      .catch((error) => sendResponse({ ok: false, error: errorCode(error) }));
    return true;
  }

  if (message?.type === "axcc:prefetch-paper") {
    const paperId = normalizePaperId(message.paperId);
    prefetchPaper(paperId)
      .then((paper) =>
        sendResponse({
          ok: true,
          cached: paper.cached,
          bibliographyCount: paper.bibliographyCount,
          referenceCount: paper.references.length,
          source: "Semantic Scholar",
        })
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: errorCode(error),
        })
      );
    return true;
  }

  if (message?.type === "axcc:lookup-paper") {
    const paperId = normalizePaperId(message.paperId);
    if (!paperId) {
      sendResponse({ ok: false, error: "invalid_paper", result: null });
      return false;
    }
    lookup(`arXiv:${paperId}`, [], null)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: errorCode(error), result: null }));
    return true;
  }

  if (message?.type === "axcc:lookup") {
    const reference = String(message.reference || "").trim().slice(0, 1400);
    const hrefs = Array.isArray(message.hrefs)
      ? message.hrefs.map(String).slice(0, 12)
      : [];
    const sourcePaperId = normalizePaperId(message.sourcePaperId);
    if (reference.length < 12) {
      sendResponse({ ok: false, error: "invalid_reference", result: null });
      return false;
    }
    lookup(reference, hrefs, sourcePaperId, true)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: errorCode(error),
          result: null,
          ...(error.retryAfterMs > 0 ? { retryAfterMs: error.retryAfterMs } : {}),
        })
      );
    return true;
  }

  if (message?.type === "axcc:clear-cache") {
    chrome.storage.local.get(null).then(async (all) => {
      const prefixes = [LOOKUP_CACHE_PREFIX, PAPER_CACHE_PREFIX, ...LEGACY_CACHE_PREFIXES];
      const keys = Object.keys(all).filter((key) =>
        prefixes.some((prefix) => key.startsWith(prefix))
      );
      if (keys.length) await chrome.storage.local.remove(keys);
      sendResponse({ ok: true, removed: keys.length });
    });
    return true;
  }

  return false;
});
