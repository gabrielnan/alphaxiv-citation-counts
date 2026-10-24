# alphaXiv Citation Counts

Use this Manifest V3 Chrome extension to display Semantic Scholar citation counts while reading alphaXiv papers.

## Install or update

1. [Download the source ZIP](https://github.com/gabrielnan/alphaxiv-citation-counts/archive/refs/heads/main.zip), then extract it.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked**, then select the extracted extension folder.
5. For an existing installation, click **Reload** on its extension card.
6. Reload open alphaXiv tabs.

## Read a paper

Open an alphaXiv abstract page to display the paper's citation count below its title. Switch to the PDF reader to display the same count below the toolbar. Click the count to open the paper's Semantic Scholar record.

Hover an in-text reference to display a count in alphaXiv's citation card. By default, the extension requests a reference's count when opening its card, reuses saved results on subsequent visits.

If Semantic Scholar returns a rate limit or a service error, use **Retry** beside the status. Use **Google Scholar** to search for the paper when a count is unavailable. The extension retrieves displayed counts from Semantic Scholar; the Google Scholar button opens a search in a separate tab.

The extension uses the paper's arXiv identifier for its main count, so it can request this count independently of the bibliography. When navigating between papers, it requests the new paper's count. When switching between the abstract and PDF views, it moves the existing badge.

## Configure access

Open the extension's toolbar popup to enable or disable counts, save a Semantic Scholar API key, or clear cached lookups.

Leave **Preload reference counts** off to request reference counts as you open their cards. This is the default for new and existing installations. The open paper's own count still loads when the paper opens, using a cached result when available.

Turn **Preload reference counts** on to load reference counts in advance. The extension reads the paper's Markdown bibliography, resolves available DOI and arXiv identifiers through Semantic Scholar's batch API, caches the results. It looks up remaining references as you open their cards. The setting saves immediately and applies to open alphaXiv tabs. Turning it off stops queued preload requests and scheduled retries while preserving displayed counts.

With **Save & test**, request a live count for *Flow Matching for Generative Modeling* before saving the proposed key in `chrome.storage.local`. The extension sends this key to Semantic Scholar in its API request headers.

The extension serializes Semantic Scholar requests with at least 1.1 seconds between starts. With a saved key, it retries rate limits and service failures up to twice. Without a key, it reports these errors immediately so the reader can retry or use Google Scholar.

The extension caches successful counts for seven days, retries empty bibliography records after an hour. After updating to version 1.9, it uses a new cache version when reading counts. Use **Clear cache** to remove saved lookup results and refresh visible badges.

## Development checks

Run the local matching, background, and request pacing tests:

```sh
node --test test-shared.mjs test-background.mjs test-background-s2-rate-limit.mjs
```

For a live Semantic Scholar lookup, optionally provide `SEMANTIC_SCHOLAR_API_KEY`:

```sh
node test-background-live.mjs
```

Run the Chrome integration checks with Playwright available through `NODE_PATH`:

```sh
NODE_PATH=/path/to/node_modules node test-e2e.mjs
```

During the integration checks, Chrome loads this unpacked extension in a temporary profile and opens real alphaXiv pages. The test supplies Semantic Scholar responses to exercise successful counts, rate limits, missing records, retries, cache clearing, the enable switch, navigation between papers. It also checks request counts in both loading modes, saved preferences, page and reference badges after DOM updates. Screenshots are saved under `test-results/`.
