# Requirements Inventory — TTB AI-Powered Alcohol Label Verification (Take-Home)

**Doc ID:** TH
**Source document:** `Take-Home Project_ AI-Powered Alcohol Label Verification App.docx`
(`/Users/troy/Documents/G.Assignments/`), sha256 `7f50443d68066298042d808ef08611b49393ed14ace13ee810c9807a9f59d2e4`
**Source cache:** `audit/requirements/source-TH.md` (textutil extraction, verified complete
against `word/document.xml` character count). The docx has no page numbers, so `Source:`
cites **line numbers in the source cache** instead of pages.

**Extraction note:** the document's explicit "Technical Requirements" section contains only
stack-freedom language. The binding requirements are embedded in stakeholder interview
notes and the Deliverables/Evaluation sections — the brief itself says "we also value how
you fill in gaps independently." Requirements below are extracted from wherever an
independently checkable obligation appears, regardless of section.

---

## TH-R1
- **Source:** source-TH.md, L9 (Sarah Chen interview)
- **Quote:** "An agent pulls up an application, looks at the label artwork, and checks that what's on the label matches what's in the application. Brand name matches? Check. ABV is correct? Check. Government warning is there? Check."
- **Meaning in code:** The core loop: app accepts application data + label artwork image, uses AI to read the label, and reports per-field match/mismatch verdicts (at minimum brand name, ABV, government warning presence).
- **Type:** functional
- **Acceptance evidence:** End-to-end: submit an application record + label image → per-field verification results render with match/mismatch per field.
- **Status:** active

## TH-R2
- **Source:** source-TH.md, L11 (Sarah Chen interview)
- **Quote:** "If we can't get results back in about 5 seconds, nobody's going to use it. We learned that the hard way."
- **Meaning in code:** Single-label verification completes in ~5 seconds wall-clock from submission to rendered result.
- **Type:** non-functional
- **Acceptance evidence:** Measured latency of the single-label verify flow ≤ ~5s (p50, realistic image); measurement method documented.
- **Status:** active

## TH-R3
- **Source:** source-TH.md, L12 (Sarah Chen interview)
- **Quote:** "We need something my mother could figure out—she's 73 and just learned to video call her grandkids last year, if that gives you a benchmark. Half our team is over 50. Clean, obvious, no hunting for buttons."
- **Meaning in code:** UI is a single obvious primary flow: large controls, minimal navigation, no hidden actions; usable by low-tech-comfort users without training.
- **Type:** non-functional
- **Acceptance evidence:** Heuristic UX review: primary action reachable without hunting; flow completable with no instructions.
- **Status:** active

## TH-R4
- **Source:** source-TH.md, L13 (Sarah Chen interview)
- **Quote:** "during peak season, we get these big importers who dump 200, 300 label applications on us at once. Right now we literally have to process them one at a time. If there was some way to handle batch uploads, that would be huge."
- **Meaning in code:** Batch mode: upload/submit many label applications at once; each processed and reported individually (scale reference: 200–300).
- **Type:** functional
- **Acceptance evidence:** Batch upload of N labels produces N per-item verdicts with progress/summary view.
- **Status:** active

## TH-R5
- **Source:** source-TH.md, L20 (Marcus Williams interview)
- **Quote:** "For this prototype, we're not looking to integrate with COLA directly—that's a whole different beast with its own authorization requirements. Think of this as a standalone proof-of-concept that could potentially inform future procurement decisions."
- **Meaning in code:** Standalone app; no COLA/registry integration; application data is entered or uploaded directly into this tool.
- **Type:** functional (scope constraint)
- **Acceptance evidence:** Architecture contains no external system-of-record integration; data entry is self-contained.
- **Status:** active

## TH-R6
- **Source:** source-TH.md, L21 (Marcus Williams interview)
- **Quote:** "But for a prototype? Just don't do anything crazy. We're not storing anything sensitive for this exercise."
- **Meaning in code:** No PII or sensitive data persisted; sane baseline security (no exposed secrets, no wild permissions); scope-appropriate, documented.
- **Type:** non-functional
- **Acceptance evidence:** Data model stores only label/application fields; README states the data-handling posture.
- **Status:** active

## TH-R7
- **Source:** source-TH.md, L22 (Marcus Williams interview)
- **Quote:** "our network blocks outbound traffic to a lot of domains, so keep that in mind if you're thinking about cloud APIs. During the scanning vendor pilot, half their features didn't work because our firewall blocked connections to their ML endpoints."
- **Meaning in code:** Design consciously addresses constrained-network deployment: minimal, well-known external endpoints (or local inference), graceful failure when an endpoint is unreachable, and the trade-off documented.
- **Type:** non-functional
- **Acceptance evidence:** Docs name every outbound dependency and the degradation/failure behavior when it is blocked.
- **Status:** active

## TH-R8
- **Source:** source-TH.md, L27 (Dave Morrison interview)
- **Quote:** "I had one last week where the brand name was 'STONE'S THROW' on the label but 'Stone's Throw' in the application. Technically a mismatch? Sure. But it's obviously the same thing. You need judgment."
- **Meaning in code:** Field matching applies judgment, not strict string equality: case/punctuation/format-insensitive comparison (or AI-judged equivalence) that treats obviously-same values as matches, ideally with a confidence/explanation rather than a silent hard fail.
- **Type:** functional
- **Acceptance evidence:** Test case: label "STONE'S THROW" vs application "Stone's Throw" → match (or flagged-equivalent), not a rejection.
- **Status:** active

## TH-R9
- **Source:** source-TH.md, L33 (Jenny Park interview)
- **Quote:** "the warning statement check is actually trickier than it sounds. It has to be exact. Like, word-for-word, and the 'GOVERNMENT WARNING:' part has to be in all caps and bold."
- **Meaning in code:** Government warning verified word-for-word against the statutory text; 'GOVERNMENT WARNING:' prefix checked for all-caps; bold/formatting checked or explicitly documented as a limitation. Strict where TH-R8 is lenient — the two matching regimes coexist deliberately.
- **Type:** functional
- **Acceptance evidence:** Test cases: exact warning → pass; 'Government Warning' title-case → fail; reworded warning → fail.
- **Status:** active

## TH-R10
- **Source:** source-TH.md, L34 (Jenny Park interview)
- **Quote:** "it would be amazing if the tool could handle images that aren't perfectly shot. I've seen labels that are photographed at weird angles, or the lighting is bad, or there's glare on the bottle."
- **Meaning in code:** Stretch (speaker: "maybe out of scope for a prototype"): tolerate angled/low-light/glare images, or at minimum fail gracefully with an "image unreadable — request better image" outcome instead of a wrong verdict.
- **Type:** functional (stretch)
- **Acceptance evidence:** Imperfect-image test set → either correct extraction or an explicit unreadable/low-confidence outcome; never a confident wrong verdict.
- **Status:** active

## TH-R11
- **Source:** source-TH.md, L51–L57 (Sample Label)
- **Quote:** "Your app should handle labels containing information like the example below:"
- **Meaning in code:** Handles a distilled-spirits label carrying at least: Brand Name, Class/Type, Alcohol Content (e.g. "45% Alc./Vol. (90 Proof)"), Net Contents ("750 mL"), Government Warning. (Reference list L42–L48 adds bottler name/address and country of origin as elements that vary by beverage type.)
- **Type:** functional
- **Acceptance evidence:** The OLD TOM DISTILLERY example (or equivalent) extracts and verifies end-to-end across all five example fields.
- **Status:** active

## TH-R12
- **Source:** source-TH.md, L58 (Sample Label)
- **Quote:** "We encourage you to create or source additional test labels—AI image generation tools work well for this."
- **Meaning in code:** Repo ships a test-label image set (generated or sourced) exercising the verification paths. Encouraged, not mandated — but it is the only way several acceptance tests run.
- **Type:** process
- **Acceptance evidence:** Test label assets present in repo/deployment and referenced by tests or demo instructions.
- **Status:** active

## TH-R13
- **Source:** source-TH.md, L61–L62 (Deliverables)
- **Quote:** "Source Code Repository (GitHub or similar)" / "All source code"
- **Meaning in code:** Public/shareable repo containing all source.
- **Type:** process
- **Acceptance evidence:** Repo URL accessible to evaluators; buildable from clone.
- **Status:** active

## TH-R14
- **Source:** source-TH.md, L63 (Deliverables)
- **Quote:** "README with setup and run instructions"
- **Meaning in code:** README covers setup + run from scratch.
- **Type:** process
- **Acceptance evidence:** Fresh-clone walkthrough of README succeeds.
- **Status:** active

## TH-R15
- **Source:** source-TH.md, L64 (Deliverables)
- **Quote:** "Brief documentation of approach, tools used, assumptions made"
- **Meaning in code:** Docs section covering approach, tool choices, and assumptions.
- **Type:** process
- **Acceptance evidence:** Doc exists and names approach, tools, assumptions explicitly.
- **Status:** active

## TH-R16
- **Source:** source-TH.md, L65–L66 (Deliverables)
- **Quote:** "Deployed Application URL" / "Working prototype we can access and test"
- **Meaning in code:** Live deployment reachable by evaluators; core flow works there, not just locally.
- **Type:** process
- **Acceptance evidence:** URL loads for an outside evaluator; single-label verify succeeds on the deployed instance.
- **Status:** active

## TH-R17
- **Source:** source-TH.md, L69 (Evaluation Criteria)
- **Quote:** "Correctness and completeness of core requirements"
- **Meaning in code:** Rubric line — core loop (TH-R1, TH-R11) works correctly and completely.
- **Type:** process
- **Acceptance evidence:** All functional entries above trace green.
- **Status:** active

## TH-R18
- **Source:** source-TH.md, L70 (Evaluation Criteria)
- **Quote:** "Code quality and organization"
- **Meaning in code:** Rubric line — clean structure, sensible modules, no slop.
- **Type:** process
- **Acceptance evidence:** Code review / lint / typecheck green; coherent architecture doc.
- **Status:** active

## TH-R19
- **Source:** source-TH.md, L71 (Evaluation Criteria)
- **Quote:** "Appropriate technical choices for the scope"
- **Meaning in code:** Rubric line — stack sized to a prototype, not over- or under-engineered; choices defended in docs.
- **Type:** process
- **Acceptance evidence:** Approach doc justifies each major choice against scope.
- **Status:** active

## TH-R20
- **Source:** source-TH.md, L72 (Evaluation Criteria)
- **Quote:** "User experience and error handling"
- **Meaning in code:** Rubric line — TH-R3 plus explicit failure states: bad image, API failure, timeout, malformed input all produce useful UI outcomes.
- **Type:** process
- **Acceptance evidence:** Error-path walkthrough: each failure mode has a designed state.
- **Status:** active

## TH-R21
- **Source:** source-TH.md, L73 (Evaluation Criteria)
- **Quote:** "Attention to requirements"
- **Meaning in code:** Rubric line — the buried interview requirements (5s, batch, fuzzy vs strict matching, UX benchmark) are all visibly addressed.
- **Type:** process
- **Acceptance evidence:** Traceability: every TH-R entry addressed in code or explicitly documented as descoped.
- **Status:** active

## TH-R22
- **Source:** source-TH.md, L74 (Evaluation Criteria)
- **Quote:** "Creative problem-solving"
- **Meaning in code:** Rubric line — at least one differentiated, well-judged idea beyond the literal ask (e.g. confidence-based triage, agent-review queue).
- **Type:** process
- **Acceptance evidence:** Docs/demo call out the differentiator(s).
- **Status:** active

## TH-R23
- **Source:** source-TH.md, L75 (Evaluation Criteria)
- **Quote:** "A working core application with clean code is preferred over ambitious but incomplete features. Document any trade-offs or limitations."
- **Meaning in code:** Two obligations: (a) prioritization — ship the working core before stretch features; (b) a written trade-offs/limitations section.
- **Type:** process
- **Acceptance evidence:** Trade-offs section exists; no half-built feature ships ahead of a broken core path.
- **Status:** active
