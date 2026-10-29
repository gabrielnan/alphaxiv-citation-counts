(function () {
  "use strict";

  const ROW_CLASS = "axcc-citation-count";
  const CARD_SELECTOR = ".absolute.z-50, .fixed.z-50";
  const CONTENT_VERSION = chrome.runtime.getManifest().version;
  document.documentElement.dataset.axccHelperVersion = CONTENT_VERSION;
  const PAPER_CLASS = "axcc-paper-count";
  const BOOKMARK_CLASS = "axcc-bookmark-count";
  const REFERENCE_RETRY_MS = 500;
  const referenceStates = new Map();
  let bookmarkTimer = null;
  let bookmarkPending = false;
  let enabled = false;
  let preloadReferences = false;
  let paperState = null;
  let configRevision = 0;
  let scanQueued = false;
  const prefetchState = {
    paperId: null,
    status: "idle",
    attempt: 0,
    timer: null,
  };

  chrome.storage.local.get({ axccEnabled: true, axccPreloadReferences: false }).then((settings) => {
    enabled = settings.axccEnabled;
    preloadReferences = settings.axccPreloadReferences === true;
    if (enabled) scan();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.axccPreloadReferences) {
      preloadReferences = changes.axccPreloadReferences.newValue === true;
      configRevision++;
      resetPaperPrefetch();
      if (enabled) ensurePaperPrefetch();
    }
    if (changes.axccEnabled) enabled = changes.axccEnabled.newValue !== false;
    if (changes.axccEnabled || changes.semanticScholarApiKey || changes.axccConfigRevision) {
      configRevision++;
      resetPaperPrefetch();
      paperState = null;
      clearTimeout(bookmarkTimer);
      bookmarkTimer = null;
      for (const state of referenceStates.values()) clearTimeout(state.timer);
      referenceStates.clear();
      document.querySelectorAll(`.${ROW_CLASS}`).forEach((row) => row.remove());
      document.querySelectorAll("[data-axcc-reference]").forEach((card) => {
        delete card.dataset.axccReference;
      });
      if (enabled) scan();
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "axcc:diagnostics") return false;
    sendResponse({
      ok: true,
      version: CONTENT_VERSION,
      page: location.href,
      citationRows: document.querySelectorAll(`.${ROW_CLASS}:not(.${PAPER_CLASS}):not(.${BOOKMARK_CLASS})`).length,
      paperRows: document.querySelectorAll(`.${PAPER_CLASS}`).length,
      bookmarkRows: document.querySelectorAll(`.${BOOKMARK_CLASS}`).length,
      preloadReferences,
      loadingRows: document.querySelectorAll(`.${ROW_CLASS}.axcc-loading`).length,
    });
    return false;
  });

  function citationCards() {
    const cards = new Set(document.querySelectorAll(CARD_SELECTOR));
    const markers = document.querySelectorAll(
      'a[aria-label="Search for citation"], a.line-clamp-4'
    );
    for (const marker of markers) {
      const exact = marker.closest(CARD_SELECTOR);
      if (exact) {
        cards.add(exact);
        continue;
      }
      let node = marker.parentElement;
      for (let depth = 0; node && depth < 7; depth++, node = node.parentElement) {
        const text = node.textContent || "";
        const position = getComputedStyle(node).position;
        if (/Jump to page/i.test(text) && (position === "absolute" || position === "fixed")) {
          cards.add(node);
          break;
        }
      }
    }
    return cards;
  }

  function referenceLink(card) {
    const links = Array.from(card.querySelectorAll("a[href]"))
      .filter((link) => !link.closest(`.${ROW_CLASS}`));
    const paper = links.find((link) =>
      /^https:\/\/(?:www\.)?alphaxiv\.org\/(?:abs|overview|pdf)\//i.test(link.href) &&
      link.textContent.trim().length >= 12
    );
    if (paper) return paper;
    const preferred = card.querySelector("a.line-clamp-4");
    if (preferred && preferred.textContent.trim().length >= 20) return preferred;
    if (card.matches(".fixed.z-50")) return null;

    return links.find((link) => {
      const text = (link.textContent || "").replace(/\s+/g, " ").trim();
      return (
        text.length >= 20 &&
        !/^(search|jump to|open|view|cited by)/i.test(text) &&
        link.getAttribute("aria-label") !== "Search for citation"
      );
    });
  }

  function referenceText(link) {
    const visible = (link.textContent || "").replace(/\s+/g, " ").trim();
    if (visible.length >= 12) return visible;
    try {
      const query = new URL(link.href).searchParams.get("q");
      return (query || "").replace(/\s+/g, " ").trim();
    } catch {
      return visible;
    }
  }

  function paperIdFromPath(pathname) {
    const match = pathname.match(
      /^\/(?:abs|overview|pdf)\/(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?(?:\/|$)/i
    );
    return match?.[1] || null;
  }

  function sourcePaperId() {
    return paperIdFromPath(location.pathname);
  }

  function bookmarksPage() {
    return /^\/bookmarks\/?$/i.test(location.pathname);
  }

  function linkedPaperId(link) {
    try {
      const url = new URL(link.href);
      return /^https:\/\/(?:www\.)?alphaxiv\.org\//i.test(url.href)
        ? paperIdFromPath(url.pathname) : null;
    } catch {
      return null;
    }
  }

  function bookmarkTitles() {
    const titles = new Map();
    for (const link of document.querySelectorAll("a[href]")) {
      if (link.closest(`.${ROW_CLASS}, ${CARD_SELECTOR}, nav, aside, [role="navigation"]`)) continue;
      const paperId = linkedPaperId(link);
      if (!paperId) continue;
      let container = link;
      for (let depth = 0; container && depth < 5; depth++, container = container.parentElement) {
        const otherPaper = Array.from(container.querySelectorAll("a[href]"))
          .some((anchor) => linkedPaperId(anchor) && linkedPaperId(anchor) !== paperId);
        if (otherPaper) break;
        const candidates = Array.from(container.querySelectorAll('h2, h3, [class*="line-clamp"], p, span, div'));
        const title = candidates.find((node) =>
          !node.closest(`.${ROW_CLASS}`) && node.textContent.trim().length >= 4 &&
          !/^(added|saved)\s/i.test(node.textContent.trim()) &&
          (node.matches('h2, h3, [class*="line-clamp"]') || node.children.length === 0)
        ) || (!container.querySelector("img") && container.textContent.trim().length >= 4 ? container : null);
        if (!title) continue;
        titles.set(title, { link, paperId });
        break;
      }
    }
    return titles;
  }

  function enhanceBookmarks() {
    if (!bookmarksPage()) return;
    for (const [title, { link, paperId }] of bookmarkTitles()) {
      const previous = referenceStates.get(title);
      if (previous?.bookmark && previous.key === paperId && currentReference(previous)) {
        if (title.nextElementSibling !== previous.row) title.insertAdjacentElement("afterend", previous.row);
        continue;
      }
      if (previous) {
        pauseReference(previous);
        previous.row.remove();
        referenceStates.delete(title);
      }
      if (!cardVisible(title)) continue;
      const row = loadingRow();
      row.classList.add(BOOKMARK_CLASS);
      row.dataset.axccPaperId = paperId;
      title.insertAdjacentElement("afterend", row);
      title.dataset.axccReference = paperId;
      referenceStates.set(title, {
        card: title, row, key: paperId, reference: `arXiv:${paperId}`, hrefs: [],
        query: title.textContent.trim(), paperId: null, link, bookmark: true,
        timer: null, pending: false, retryable: false, retryAt: 0, rendered: false,
      });
    }
    scheduleBookmarkLookups();
  }

  function scheduleBookmarkLookups() {
    clearTimeout(bookmarkTimer);
    bookmarkTimer = null;
    if (bookmarkPending || !enabled || !bookmarksPage() || document.hidden) return;
    const candidates = Array.from(referenceStates.values()).filter((state) =>
      state.bookmark && currentReference(state) && cardVisible(state.card) &&
      !state.pending && (!state.rendered || state.retryable)
    ).sort((left, right) => Number(left.rendered) - Number(right.rendered) || left.retryAt - right.retryAt);
    const next = candidates[0];
    if (!next) return;
    bookmarkTimer = setTimeout(async () => {
      bookmarkTimer = null;
      if (!currentReference(next) || !cardVisible(next.card)) {
        scheduleBookmarkLookups();
        return;
      }
      bookmarkPending = true;
      try {
        await lookupReference(next);
      } finally {
        bookmarkPending = false;
        scheduleBookmarkLookups();
      }
    }, Math.max(0, next.retryAt - Date.now()));
  }

  function resetPaperPrefetch() {
    clearTimeout(prefetchState.timer);
    prefetchState.paperId = null;
    prefetchState.status = "idle";
    prefetchState.attempt = 0;
  }

  function ensurePaperPrefetch() {
    if (!enabled || !preloadReferences) return;
    const paperId = sourcePaperId();
    if (!paperId) {
      clearTimeout(prefetchState.timer);
      prefetchState.paperId = null;
      prefetchState.status = "idle";
      return;
    }
    if (paperId !== prefetchState.paperId) {
      clearTimeout(prefetchState.timer);
      prefetchState.paperId = paperId;
      prefetchState.status = "idle";
      prefetchState.attempt = 0;
    }
    if (prefetchState.status !== "idle") return;
    prefetchState.status = "loading";
    const revision = configRevision;
    sendRuntimeMessage({ type: "axcc:prefetch-paper", paperId }, 35_000)
      .then((response) => {
        if (paperId !== sourcePaperId() || revision !== configRevision || !enabled || !preloadReferences) return;
        if (response?.ok) {
          prefetchState.status = "ready";
          return;
        }
        if (["s2_busy", "s2_unavailable"].includes(response?.error) && prefetchState.attempt < 3) {
          const delays = [10_000, 30_000, 90_000];
          const delay = delays[prefetchState.attempt++];
          prefetchState.status = "waiting";
          prefetchState.timer = setTimeout(() => {
            prefetchState.status = "idle";
            ensurePaperPrefetch();
          }, delay);
          return;
        }
        prefetchState.status = "failed";
      })
      .catch(() => {
        if (paperId === sourcePaperId() && revision === configRevision) prefetchState.status = "failed";
      });
  }

  function fingerprint(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function sendRuntimeMessage(message, timeoutMs) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error("Extension request timed out");
        error.code = "lookup_timeout";
        reject(error);
      }, timeoutMs);
    });
    return Promise.race([chrome.runtime.sendMessage(message), timeout]).finally(() => {
      clearTimeout(timer);
    });
  }

  function loadingRow() {
    const row = document.createElement("div");
    row.className = `${ROW_CLASS} axcc-loading`;
    row.dataset.axccVersion = CONTENT_VERSION;
    row.setAttribute("role", "status");
    row.innerHTML = '<span class="axcc-spinner" aria-hidden="true"></span><span>Looking up citations…</span>';
    return row;
  }

  function scholarLink(query) {
    const link = document.createElement("a");
    link.className = "axcc-scholar";
    link.href = `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Google Scholar";
    return link;
  }

  function showResult(row, result, error, query, links = true) {
    row.classList.remove("axcc-loading", "axcc-unavailable");
    row.replaceChildren();

    if (result?.source !== "Semantic Scholar" || result.citationCount == null) {
      row.classList.add("axcc-unavailable");
      const status = document.createElement("span");
      if (error === "s2_auth") {
        status.textContent = "Semantic Scholar key rejected";
        row.title = "Check the Semantic Scholar key in the extension popup.";
      } else if (error === "s2_busy") {
        status.textContent = "Semantic Scholar is rate-limited";
        row.title = "Retry shortly or add a Semantic Scholar API key in the extension popup.";
      } else if (error === "lookup_timeout") {
        status.textContent = "Citation lookup timed out";
        row.title = "Retry the citation lookup.";
      } else if (error) {
        status.textContent = "Semantic Scholar is unavailable";
        row.title = "Retry the citation lookup.";
      } else {
        status.textContent = "No Semantic Scholar count available";
        row.title = "Semantic Scholar did not return a confident match with a citation count.";
      }
      row.append(status);
      if (links) row.append(scholarLink(query));
      return Boolean(error);
    }

    const count = Number(result.citationCount).toLocaleString();
    const badge = result.url && links ? document.createElement("a") : document.createElement("span");
    badge.className = "axcc-result";
    badge.textContent = `${count} citation${result.citationCount === 1 ? "" : "s"}`;
    if (result.url && links) {
      badge.href = result.url;
      badge.target = "_blank";
      badge.rel = "noopener noreferrer";
    }
    const source = document.createElement("span");
    source.className = "axcc-source";
    source.textContent = "Semantic Scholar";
    row.append(badge, source);
    row.title = result.title ? `Matched: ${result.title}` : "Citation data from Semantic Scholar";
    return false;
  }

  function makeRetryable(row, retry) {
    const button = document.createElement("button");
    button.className = "axcc-retry";
    button.type = "button";
    button.textContent = "Retry";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      retry();
    }, { once: true });
    row.append(button);
  }

  function paperAnchor() {
    if (/^\/pdf\//i.test(location.pathname)) {
      return document.querySelector('[role="tablist"][aria-label="Paper"]')?.parentElement;
    }
    return Array.from(document.querySelectorAll("h1")).find((node) => node.getClientRects().length);
  }

  function paperTitle() {
    return document.querySelector("h1")?.textContent?.trim() || `arXiv:${sourcePaperId()}`;
  }

  function enhancePaper() {
    const paperId = sourcePaperId();
    if (!paperId || paperState?.paperId !== paperId) {
      document.querySelectorAll(`.${PAPER_CLASS}`).forEach((row) => row.remove());
      paperState = null;
    }
    if (!paperId) return;
    const anchor = paperAnchor();
    if (!anchor) return;
    if (paperState) {
      if (anchor.nextElementSibling !== paperState.row) {
        anchor.insertAdjacentElement("afterend", paperState.row);
      }
      paperState.row.classList.toggle("axcc-paper-reader", /^\/pdf\//i.test(location.pathname));
      return;
    }

    const row = loadingRow();
    row.classList.add(PAPER_CLASS);
    row.classList.toggle("axcc-paper-reader", /^\/pdf\//i.test(location.pathname));
    row.dataset.axccPaperId = paperId;
    anchor.insertAdjacentElement("afterend", row);
    const state = { paperId, row };
    paperState = state;
    const retry = () => {
      if (paperState !== state || !row.isConnected) return;
      row.remove();
      paperState = null;
      enhancePaper();
    };
    sendRuntimeMessage({ type: "axcc:lookup-paper", paperId }, 45_000)
      .then((response) => {
        if (!enabled || paperState !== state || sourcePaperId() !== paperId) return;
        if (showResult(row, response?.ok ? response.result : null, response?.error, paperTitle())) {
          makeRetryable(row, retry);
        }
      })
      .catch((error) => {
        if (!enabled || paperState !== state || sourcePaperId() !== paperId) return;
        showResult(row, null, error?.code || "lookup_failed", paperTitle());
        makeRetryable(row, retry);
      });
  }

  function cardVisible(card) {
    if (document.hidden || !card.isConnected) return false;
    const bounds = card.getBoundingClientRect();
    const style = getComputedStyle(card);
    return style.visibility !== "hidden" && style.opacity !== "0" &&
      bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 &&
      bounds.top < innerHeight && bounds.right > 0 && bounds.left < innerWidth;
  }

  function currentReference(state) {
    return enabled && referenceStates.get(state.card) === state &&
      state.row.isConnected && state.paperId === sourcePaperId() &&
      (!state.bookmark || (bookmarksPage() && state.link.isConnected && linkedPaperId(state.link) === state.key)) &&
      state.card.dataset.axccReference === state.key;
  }

  function pauseReference(state) {
    clearTimeout(state.timer);
    state.timer = null;
  }

  function scheduleReferenceRetry(state) {
    if (state.bookmark) {
      scheduleBookmarkLookups();
      return;
    }
    if (state.timer !== null || state.pending || !state.retryable ||
        !currentReference(state) || !cardVisible(state.card)) return;
    const delay = Math.max(REFERENCE_RETRY_MS, state.retryAt - Date.now());
    state.timer = setTimeout(() => {
      state.timer = null;
      if (currentReference(state) && cardVisible(state.card)) void lookupReference(state);
    }, delay);
  }

  async function lookupReference(state) {
    if (state.pending || !currentReference(state) || !cardVisible(state.card)) return;
    pauseReference(state);
    state.pending = true;
    let response;
    try {
      response = await sendRuntimeMessage({
        type: "axcc:lookup",
        reference: state.reference,
        hrefs: state.hrefs,
        sourcePaperId: state.paperId,
      }, 45_000);
    } catch (error) {
      response = { error: error?.code || "lookup_failed" };
    } finally {
      state.pending = false;
    }
    if (!currentReference(state)) return;
    const error = response?.error;
    state.retryable = ["s2_busy", "s2_unavailable", "lookup_timeout", "lookup_failed"].includes(error);
    state.retryAt = Date.now() + Math.max(REFERENCE_RETRY_MS, Number(response?.retryAfterMs) || 0);
    if (!state.rendered || state.error !== error || !state.retryable) {
      const links = !state.row.closest("a");
      const retryable = showResult(state.row, response?.ok ? response.result : null, error, state.query || state.reference, links);
      if (state.retryable) {
        const hint = document.createElement("span");
        hint.className = "axcc-auto-retry";
        hint.textContent = "Retrying automatically";
        state.row.append(hint);
      } else if (retryable && links) {
        makeRetryable(state.row, () => {
          state.rendered = false;
          if (state.bookmark) scheduleBookmarkLookups();
          else void lookupReference(state);
        });
      }
      state.error = error;
      state.rendered = true;
    }
    scheduleReferenceRetry(state);
  }

  function enhance(card) {
    const link = referenceLink(card);
    if (!link) return;
    const reference = referenceText(link);
    if (reference.length < 12) return;

    // Compare the reference links before adding citation controls.
    const hrefs = Array.from(card.querySelectorAll("a[href]"))
      .filter((anchor) => !anchor.closest(`.${ROW_CLASS}`))
      .map((anchor) => anchor.href)
      .filter(Boolean)
      .slice(0, 12);
    const key = fingerprint(reference + "\n" + hrefs.join("\n"));
    const previous = referenceStates.get(card);
    if (previous?.key === key && currentReference(previous)) {
      if (cardVisible(card)) scheduleReferenceRetry(previous);
      else pauseReference(previous);
      return;
    }
    if (previous) pauseReference(previous);
    referenceStates.delete(card);
    if (!cardVisible(card)) return;
    card.dataset.axccReference = key;
    card.querySelectorAll(`.${ROW_CLASS}`).forEach((row) => row.remove());
    const row = loadingRow();
    link.insertAdjacentElement("afterend", row);
    const state = {
      card, row, key, reference, hrefs, paperId: sourcePaperId(),
      timer: null, pending: false, retryable: false, retryAt: 0, rendered: false,
    };
    referenceStates.set(card, state);
    void lookupReference(state);
  }

  function scan() {
    scanQueued = false;
    if (!enabled) return;
    for (const [card, state] of referenceStates) {
      if (!currentReference(state)) {
        pauseReference(state);
        if (state.bookmark) state.row.remove();
        referenceStates.delete(card);
      } else if (!cardVisible(card)) {
        pauseReference(state);
      }
    }
    enhancePaper();
    ensurePaperPrefetch();
    enhanceBookmarks();
    if (!bookmarksPage()) {
      clearTimeout(bookmarkTimer);
      bookmarkTimer = null;
    }
    for (const card of citationCards()) void enhance(card);
  }

  function queueScan() {
    if (scanQueued || !enabled) return;
    scanQueued = true;
    queueMicrotask(scan);
  }

  const observer = new MutationObserver(queueScan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden", "href"],
  });

  document.addEventListener("visibilitychange", queueScan);
  window.addEventListener("scroll", queueScan, { capture: true, passive: true });
  window.addEventListener("resize", queueScan, { passive: true });
  window.addEventListener("popstate", queueScan);
  window.navigation?.addEventListener("navigatesuccess", queueScan);
})();
