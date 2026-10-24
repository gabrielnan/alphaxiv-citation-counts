(function () {
  "use strict";

  const ROW_CLASS = "axcc-citation-count";
  const CONTENT_VERSION = chrome.runtime.getManifest().version;
  document.documentElement.dataset.axccHelperVersion = CONTENT_VERSION;
  const PAPER_CLASS = "axcc-paper-count";
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
      citationRows: document.querySelectorAll(`.${ROW_CLASS}:not(.${PAPER_CLASS})`).length,
      paperRows: document.querySelectorAll(`.${PAPER_CLASS}`).length,
      preloadReferences,
      loadingRows: document.querySelectorAll(`.${ROW_CLASS}.axcc-loading`).length,
    });
    return false;
  });

  function citationCards() {
    const cards = new Set(document.querySelectorAll(".absolute.z-50"));
    const markers = document.querySelectorAll(
      'a[aria-label="Search for citation"], a.line-clamp-4'
    );
    for (const marker of markers) {
      const exact = marker.closest(".absolute.z-50");
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
    const preferred = card.querySelector("a.line-clamp-4");
    if (preferred && preferred.textContent.trim().length >= 20) return preferred;

    return Array.from(card.querySelectorAll("a[href]")).find((link) => {
      if (link.closest(`.${ROW_CLASS}`)) return false;
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
    if (visible.length >= 20) return visible;
    try {
      const query = new URL(link.href).searchParams.get("q");
      return (query || "").replace(/\s+/g, " ").trim();
    } catch {
      return visible;
    }
  }

  function sourcePaperId() {
    const match = location.pathname.match(
      /^\/(?:abs|overview|pdf)\/(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?(?:\/|$)/i
    );
    return match?.[1] || null;
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

  function showResult(row, result, error, query) {
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
      row.append(status, scholarLink(query));
      return Boolean(error);
    }

    const count = Number(result.citationCount).toLocaleString();
    const badge = result.url ? document.createElement("a") : document.createElement("span");
    badge.className = "axcc-result";
    badge.textContent = `${count} citation${result.citationCount === 1 ? "" : "s"}`;
    if (result.url) {
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

  async function enhance(card) {
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
    const existingRow = card.querySelector(`.${ROW_CLASS}`);
    if (
      card.dataset.axccReference === key &&
      existingRow?.dataset.axccVersion === CONTENT_VERSION
    ) {
      return;
    }

    card.dataset.axccReference = key;
    card.querySelectorAll(`.${ROW_CLASS}`).forEach((row) => row.remove());
    const row = loadingRow();
    link.insertAdjacentElement("afterend", row);

    try {
      const response = await sendRuntimeMessage(
        {
          type: "axcc:lookup",
          reference,
          hrefs,
          sourcePaperId: sourcePaperId(),
        },
        45_000
      );
      if (!row.isConnected || card.dataset.axccReference !== key) return;
      const retryable = showResult(
        row,
        response?.ok ? response.result : null,
        response?.error,
        reference
      );
      if (retryable) makeRetryable(row, () => {
        if (!row.isConnected || card.dataset.axccReference !== key) return;
        delete card.dataset.axccReference;
        row.remove();
        void enhance(card);
      });
    } catch (error) {
      if (row.isConnected && card.dataset.axccReference === key) {
        const code = error?.code === "lookup_timeout" ? "lookup_timeout" : "lookup_failed";
        showResult(row, null, code, reference);
        makeRetryable(row, () => {
          if (!row.isConnected || card.dataset.axccReference !== key) return;
          delete card.dataset.axccReference;
          row.remove();
          void enhance(card);
        });
      }
    }
  }

  function scan() {
    scanQueued = false;
    if (!enabled) return;
    enhancePaper();
    ensurePaperPrefetch();
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
  });

  window.addEventListener("popstate", queueScan);
  window.navigation?.addEventListener("navigatesuccess", queueScan);
})();
