import assert from "node:assert/strict";
import {
  extractIdentifiers,
  guessTitleFromReference,
  paperMatchesReference,
  parseAlphaXivReferences,
  referenceKey,
  referenceYear,
  selectReference,
  titleCoverage,
  titleMatchScore,
} from "./shared.mjs";

assert.deepEqual(
  extractIdentifiers("Available at https://doi.org/10.1145/3292500.3330701."),
  { kind: "doi", id: "10.1145/3292500.3330701" }
);

assert.deepEqual(
  extractIdentifiers("A paper", ["https://www.alphaxiv.org/abs/2106.15928"]),
  { kind: "arxiv", id: "2106.15928" }
);

assert.deepEqual(
  extractIdentifiers("arXiv preprint arXiv:1607.06450v2"),
  { kind: "arxiv", id: "1607.06450" }
);

const citation =
  "[42] Jiqun Liu. 2023. A behavioral economics approach to interactive information retrieval. The Information Retrieval Series 48 (2023).";
assert.equal(
  guessTitleFromReference(citation),
  "A behavioral economics approach to interactive information retrieval"
);
assert.ok(titleCoverage(citation, "A Behavioral Economics Approach to Interactive Information Retrieval") > 0.95);
assert.ok(titleMatchScore(citation, "A Behavioral Economics Approach to Interactive Information Retrieval") > 0.95);
assert.equal(referenceYear(citation), 2023);
assert.ok(
  paperMatchesReference(
    {
      title: "A Behavioral Economics Approach to Interactive Information Retrieval",
      year: 2023,
      authors: [{ name: "Jiqun Liu" }],
    },
    citation
  )
);

const matchedReference = selectReference(
  [
    {
      title: "Interactive Information Retrieval",
      year: 2023,
      citationCount: 91,
    },
    {
      title: "A Behavioral Economics Approach to Interactive Information Retrieval",
      year: 2023,
      citationCount: 7,
      authors: [{ name: "Jiqun Liu" }],
    },
  ],
  citation
);
assert.equal(
  matchedReference.title,
  "A Behavioral Economics Approach to Interactive Information Retrieval"
);

const missingCount = selectReference(
  [
    {
      title: "To trust or to think: cognitive forcing functions can reduce overreliance on AI in AI-assisted decision-making",
      year: 2021,
      citationCount: null,
    },
    {
      title: "Guidelines for Human-AI Interaction",
      year: 2019,
      citationCount: 2039,
    },
  ],
  "[10] Zana Bucinca et al. 2021. To trust or to think: cognitive forcing functions can reduce overreliance on AI in AI-assisted decision-making."
);
assert.equal(missingCount, null);

const abbreviatedTitle = selectReference(
  [
    {
      title: "Cognitive Biases in Search",
      year: 2021,
      citationCount: 172,
      authors: [{ name: "Leif Azzopardi" }],
    },
  ],
  "[4] Leif Azzopardi. 2021. Cognitive biases in search: a review and reflection of cognitive biases in Information Retrieval."
);
assert.equal(abbreviatedTitle?.citationCount, 172);

const exactDoiDespiteYearDifference = selectReference(
  [
    {
      title: "Human-Centered Explainable AI",
      year: 2023,
      citationCount: 88,
      externalIds: { DOI: "10.1007/978-3-030-50334-5_29" },
    },
  ],
  "[18] Upol Ehsan and Mark Riedl. 2020. Human-Centered Explainable AI. doi:10.1007/978-3-030-50334-5_29"
);
assert.equal(exactDoiDespiteYearDifference?.citationCount, 88);

const markdown = `# Example paper

References
[1] Saleema Amershi et al. 2019. Guidelines for human-AI interaction. In CHI.
[2]
Zana Buçinca, Maja Barbara Malaya, and Krzysztof Z Gajos. 2021. To trust or to think: cognitive forcing functions can reduce overreliance on AI in AI-assisted decision-making. PACM HCI.
`;
const parsed = parseAlphaXivReferences(markdown);
assert.equal(parsed.length, 2);
assert.match(parsed[0], /^\[1] Saleema Amershi/);
assert.match(parsed[1], /To trust or to think/);

assert.equal(referenceKey(citation), referenceKey(citation));
assert.notEqual(referenceKey(citation), referenceKey(citation + " changed"));

console.log("All shared citation-matching tests passed.");
