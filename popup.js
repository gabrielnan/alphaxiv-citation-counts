const enabled = document.querySelector("#enabled");
const preloadReferences = document.querySelector("#preload-references");
const apiKey = document.querySelector("#api-key");
const save = document.querySelector("#save");
const clear = document.querySelector("#clear");
const status = document.querySelector("#status");
const pageStatus = document.querySelector("#page-status");
const extensionVersion = chrome.runtime.getManifest().version;
let savedApiKey = "";

chrome.storage.local
  .get({ axccEnabled: true, axccPreloadReferences: false, semanticScholarApiKey: "" })
  .then((settings) => {
    enabled.checked = settings.axccEnabled;
    preloadReferences.checked = settings.axccPreloadReferences === true;
    apiKey.value = settings.semanticScholarApiKey;
    savedApiKey = settings.semanticScholarApiKey;
    void checkPageHelper();
  });

function showStatus(message, tone = "neutral") {
  status.textContent = message;
  status.dataset.tone = tone;
}

function showPageStatus(message, tone = "neutral") {
  pageStatus.textContent = message;
  pageStatus.dataset.tone = tone;
}

async function checkPageHelper() {
  showPageStatus(`Extension v${extensionVersion} · checking page helper…`);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("no_active_tab");
    if (tab.url && !/^https:\/\/(?:www\.)?alphaxiv\.org\//i.test(tab.url)) {
      showPageStatus(
        `Extension v${extensionVersion} · open alphaXiv to check it`
      );
      return;
    }

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), 1_500);
    });
    const response = await Promise.race([
      chrome.tabs.sendMessage(tab.id, { type: "axcc:diagnostics" }),
      timeout,
    ]).finally(() => clearTimeout(timer));

    if (response?.version === extensionVersion) {
      showPageStatus(
        `Extension v${extensionVersion} · page helper active (${response.paperRows || 0} paper, ${response.citationRows || 0} references, ${response.bookmarkRows || 0} bookmarks)`,
        "success"
      );
    } else if (response?.version) {
      showPageStatus(
        `Extension v${extensionVersion} · page helper is outdated (v${response.version}). Reload the alphaXiv tab.`,
        "error"
      );
    } else {
      throw new Error("no_diagnostics");
    }
  } catch {
    showPageStatus(
      `Extension v${extensionVersion} · page helper not active. Reload the alphaXiv tab.`,
      "error"
    );
  }
}

function setBusy(busy) {
  save.disabled = busy;
  clear.disabled = busy;
  apiKey.disabled = busy;
  save.textContent = busy ? "Testing…" : "Save & test";
}

function sendRuntimeMessage(message, timeoutMs = 12_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  return Promise.race([chrome.runtime.sendMessage(message), timeout]).finally(() => {
    clearTimeout(timer);
  });
}

save.addEventListener("click", async () => {
  const proposedKey = apiKey.value.trim();
  setBusy(true);
  showStatus("Testing Semantic Scholar access…");
  try {
    const response = await sendRuntimeMessage({
      type: "axcc:validate-s2-key",
      apiKey: proposedKey,
    });
    if (!response?.ok) {
      if (response?.error === "s2_auth") {
        showStatus("Key rejected by Semantic Scholar. Check that it was copied completely.", "error");
      } else if (response?.error === "s2_busy") {
        showStatus(
          proposedKey
            ? "Semantic Scholar is rate-limiting this key. Try again shortly."
            : "Anonymous Semantic Scholar access is rate-limited. Add a key.",
          "error"
        );
      } else if (response?.error === "s2_unavailable") {
        showStatus("Semantic Scholar did not respond. Try again shortly.", "error");
      } else {
        showStatus("Could not reach Semantic Scholar. Check your connection and retry.", "error");
      }
      return;
    }

    await sendRuntimeMessage({ type: "axcc:clear-cache" });
    await chrome.storage.local.set({
      axccEnabled: enabled.checked,
      semanticScholarApiKey: proposedKey,
      axccConfigRevision: Date.now(),
    });
    savedApiKey = proposedKey;
    const detail = response.citationCount == null
      ? "live lookup succeeded"
      : `Flow Matching: ${Number(response.citationCount).toLocaleString()} citations`;
    showStatus(
      response.keyed
        ? `✓ S2 key works · ${detail}.`
        : `✓ Anonymous S2 works · ${detail}.`,
      "success"
    );
    await checkPageHelper();
  } catch {
    showStatus("Key test timed out. The previous saved key was kept.", "error");
  } finally {
    setBusy(false);
  }
});

apiKey.addEventListener("input", () => {
  showStatus(
    apiKey.value.trim() === savedApiKey
      ? "Saved key. Click Save & test to verify it now."
      : "Key changed but not saved. Click Save & test.",
    "neutral"
  );
});

enabled.addEventListener("change", () => {
  chrome.storage.local.set({ axccEnabled: enabled.checked });
});

preloadReferences.addEventListener("change", async () => {
  await chrome.storage.local.set({ axccPreloadReferences: preloadReferences.checked });
  showStatus(preloadReferences.checked
    ? "Reference preloading enabled. Saved automatically."
    : "References load when you open their cards. Saved automatically.");
});

clear.addEventListener("click", async () => {
  const response = await sendRuntimeMessage({ type: "axcc:clear-cache" });
  await chrome.storage.local.set({ axccConfigRevision: Date.now() });
  showStatus(
    `Cleared ${response?.removed || 0} cached lookup${response?.removed === 1 ? "" : "s"}.`,
    "success"
  );
});
