const DOI_RE = /\b(10\.\d{4,9}\/[\w.()/:;-]+)/i;
const ARXIV_RE = /(?:arxiv(?:\.org\/(?:abs|pdf)\/|\s*(?:preprint\s*)?(?:arxiv\s*)?:?\s*))([a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i;
const ALPHAXIV_RE = /alphaxiv\.org\/(?:abs|overview|pdf)\/([a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "or",
  "the",
  "to",
  "via",
  "with",
]);

export function decodeLoose(value) {
  let out = String(value || "");
  for (let i = 0; i < 2; i++) {
    try {
      const decoded = decodeURIComponent(out.replace(/\+/g, " "));
      if (decoded === out) break;
      out = decoded;
    } catch {
      break;
    }
  }
  return out;
}

function cleanDoi(value) {
  return value.replace(/[\])}>,.;:]+$/, "").toLowerCase();
}

export function extractIdentifiers(reference, hrefs = []) {
  const haystacks = [reference, ...hrefs].map(decodeLoose).filter(Boolean);
  for (const text of haystacks) {
    const doi = text.match(DOI_RE)?.[1];
    if (doi) return { kind: "doi", id: cleanDoi(doi) };
  }
  for (const text of haystacks) {
    const arxiv = text.match(ARXIV_RE)?.[1] || text.match(ALPHAXIV_RE)?.[1];
    if (arxiv) return { kind: "arxiv", id: arxiv.replace(/v\d+$/i, "") };
  }
  return null;
}

export function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulWords(value) {
  return new Set(
    normalizeText(value)
      .split(" ")
      .filter((word) => word.length > 1 && !STOP_WORDS.has(word) && !/^\d+$/.test(word))
  );
}

export function guessTitleFromReference(reference) {
  const cleaned = String(reference || "")
    .replace(/^\s*\[\d+\]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";

  const afterYear = cleaned.match(/\b(?:19|20)\d{2}\s*[.,:;]\s*(.+)$/)?.[1];
  if (afterYear) {
    const firstSentence = afterYear.split(/\.\s+(?=[A-Z])/)[0].trim();
    if (firstSentence.length >= 16) return firstSentence.slice(0, 300);
  }

  const candidates = cleaned
    .split(/\.\s+(?=[A-Z])/)
    .map((part) => part.trim())
    .filter(
      (part) =>
        part.length >= 16 &&
        part.length <= 300 &&
        !/^https?:/i.test(part) &&
        !/\b(?:19|20)\d{2}\b/.test(part)
    )
    .sort((a, b) => b.length - a.length);
  return (candidates[0] || cleaned).slice(0, 300);
}

// Compare candidate title words against the full bibliography entry.
export function titleCoverage(reference, candidateTitle) {
  const referenceWords = meaningfulWords(reference);
  const titleWords = meaningfulWords(candidateTitle);
  if (!referenceWords.size || !titleWords.size) return 0;
  let overlap = 0;
  for (const word of titleWords) {
    if (referenceWords.has(word)) overlap++;
  }
  return overlap / titleWords.size;
}

export function titleMatchScore(reference, candidateTitle) {
  const hintedTitle = guessTitleFromReference(reference);
  const referenceWords = meaningfulWords(hintedTitle);
  const candidateWords = meaningfulWords(candidateTitle);
  if (!referenceWords.size || !candidateWords.size) return 0;
  let overlap = 0;
  for (const word of candidateWords) {
    if (referenceWords.has(word)) overlap++;
  }
  return overlap / Math.max(referenceWords.size, candidateWords.size);
}

export function referenceYear(reference) {
  const year = String(reference || "").match(/\b((?:19|20)\d{2})\b/)?.[1];
  return year ? Number(year) : null;
}

function firstAuthorSurname(item) {
  const name = item?.authors?.[0]?.name || "";
  return normalizeText(name).split(" ").filter(Boolean).at(-1) || "";
}

function exactIdentifierMatches(item, reference) {
  const identifier = extractIdentifiers(reference);
  if (!identifier) return false;
  if (identifier.kind === "doi") {
    const candidateDoi = String(item?.externalIds?.DOI || "")
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
      .toLowerCase();
    return candidateDoi === identifier.id.toLowerCase();
  }
  const arxivId = identifier.id.replace(/v\d+$/i, "").toLowerCase();
  const candidateArxiv = String(item?.externalIds?.ArXiv || "")
    .replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, "")
    .replace(/v\d+$/i, "")
    .toLowerCase();
  return candidateArxiv === arxivId;
}

export function paperMatchesReference(item, reference) {
  if (!item?.title) return false;
  if (exactIdentifierMatches(item, reference)) return true;
  const score = titleMatchScore(reference, item.title);
  const coverage = titleCoverage(reference, item.title);
  const candidateWordCount = meaningfulWords(item.title).size;

  const expectedYear = referenceYear(reference);
  const candidateYear = Number(item.year) || null;
  if (expectedYear && candidateYear && Math.abs(expectedYear - candidateYear) > 1) {
    return false;
  }

  const surname = firstAuthorSurname(item);
  const authorMatches = !surname || normalizeText(reference).split(" ").includes(surname);
  if (score >= 0.95) return true;
  if (!authorMatches) return false;
  return score >= 0.82 || (coverage >= 0.9 && candidateWordCount >= 3);
}

export function selectReference(items, reference) {
  const ranked = (items || [])
    .filter((item) => item?.title && paperMatchesReference(item, reference))
    .map((item) => {
      const titleScore = titleMatchScore(reference, item.title);
      const coverage = titleCoverage(reference, item.title);
      const expectedYear = referenceYear(reference);
      const candidateYear = Number(item.year) || null;
      const yearBonus = expectedYear && candidateYear && expectedYear === candidateYear ? 0.05 : 0;
      const surname = firstAuthorSurname(item);
      const authorBonus = surname && normalizeText(reference).split(" ").includes(surname)
        ? 0.03
        : 0;
      return { item, rank: Math.max(titleScore, coverage * 0.92) + yearBonus + authorBonus };
    })
    .sort((a, b) => b.rank - a.rank);
  const best = ranked[0]?.item;
  return best?.citationCount != null ? best : null;
}

export function parseAlphaXivReferences(markdown) {
  const text = String(markdown || "").replace(/\r\n?/g, "\n");
  const headings = Array.from(
    text.matchAll(/^(?:#{1,6}\s*)?references\s*$/gim),
    (match) => match.index + match[0].length
  );
  if (!headings.length) return [];

  const section = text.slice(headings.at(-1));
  const markers = Array.from(section.matchAll(/^\s*\[(\d+)]\s*/gm));
  const references = [];
  for (let index = 0; index < markers.length; index++) {
    const marker = markers[index];
    const start = marker.index + marker[0].length;
    const end = markers[index + 1]?.index ?? section.length;
    const entry = section
      .slice(start, end)
      .replace(/^\s*Manuscript submitted to .*$/gim, " ")
      .replace(/^\s*\d+\s+[^\n]{1,80}\bet al\.\s*$/gim, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (entry.length >= 12) references.push(`[${marker[1]}] ${entry}`);
  }
  return references;
}

export function referenceKey(reference, hrefs = []) {
  const input = normalizeText([reference, ...hrefs].join(" ")).slice(0, 1400);
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
