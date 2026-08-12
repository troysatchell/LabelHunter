# Handoff: requirements audit, verdict-miss diagnosis, first deploy — 2026-08-12

Written for a fresh session that will start the factory. Everything below is committed or
recorded in Linear. Nothing important lives only in the last conversation.

---

## 1. Start here — the three facts that change what you do

**The deploy is live.** `https://labelhunter-web.onrender.com` returns
`{"status":"ok","service":"labelhunter",...}`. Both services run commit `3268b31`.

**Do not publish that URL.** TRO-482 (key protection) is Urgent and unstarted. No access gate,
no rate limit, no spend cap exists. An unpublished Render URL is low risk. The same URL inside
`README.md` is an open endpoint on Troy's Anthropic billing. Deploying and publishing are
separate events — TRO-482 records the rule.

**Rotate the Anthropic API key.** It was pasted into a chat transcript on 2026-08-12. It was
never in git (`.env.local` is gitignored), but it is out of the file now. Rotating means: new
key in the Anthropic console, revoke the old one, update `.env.local` and both Render services.

---

## 2. What is committed

| Commit | Contents |
|---|---|
| `8fa8999` | Reference photos, `docs/reference-photo-provenance.md`, Wave 2b tickets |
| `3268b31` | Requirements sweep, verdict-miss diagnosis, Wave 2c tickets |
| *(pending)* | `scripts/golden/batchFixture.ts` + tests, `var/` gitignore, `batch:fixture` script |

Both pushed commits have green CI. `main` and `origin/main` are in sync.

**`wip/wf-01a200bf-first-pass` (`64c9e83`) is local-only and disposable.** It holds a first pass
at the bold work. Five of its six workstreams failed adversarial review. Every finding worth
keeping is already in TRO-527 and TRO-531. Do not merge it. Do not treat it as a starting point.

---

## 3. Deployed infrastructure

Three Render resources, created from `render.yaml` as a Blueprint:

| Resource | ID | Plan |
|---|---|---|
| `labelhunter-web` | `srv-d9udgpu417fc73d43v1g` | starter (0.5 CPU / 512 MB) |
| `labelhunter-worker` | `srv-d9udgpu417fc73d43v0g` | starter |
| `labelhunter-db` | — | Postgres 16, basic-256mb |

$24.50/month total, prorated by the second.

**Change plans in `render.yaml`, never in the dashboard.** A Blueprint treats the file as source
of truth and syncs automatically. A tier bumped in the dashboard can revert on the next sync,
and you would debug a mystery slowdown.

The Render CLI is installed and authenticated. The workspace is set
(`tea-d9kevetg1s2s73807n5g`), so `render services`, `render logs`, `render deploys` and
`render postgres` all work.

**Verified by observation, not by exit code:**

- `pnpm db:migrate` ran as a pre-deploy step at 20:33:32Z.
- `GET /api/health` → HTTP 200 in 330 ms.
- `GET /api/review-queue` → `{"items":[]}`, HTTP 200 in 463 ms. That is a successful read
  against a real table, which is what proves the schema exists.

**Never measured on the deployed instance:** the verify route, batch throughput, anything under
concurrency. Those are TRO-539 and TRO-544.

---

## 4. The requirements sweep

`audit/requirements/REPORT.md`, compare mode against the 2026-08-11 baseline.

**10 VERIFIED · 9 PARTIAL · 1 IMPLEMENTED-UNVERIFIED · 3 MISSING · 0 ASSUMED**
(baseline: 6 · 9 · 3 · 5). 179 citations mechanically checked, 0 broken.

The three MISSING rows are the submission blockers, and **none is a code problem**: TH-R14
(README), TH-R15 (approach.md), TH-R16 (deployed URL — the instance now exists, but the URL
cannot be published until TRO-482 lands).

`audit/requirements/interpretations.md` is new and **binding on every later sweep**:

- **INT-001** — TH-R9 needs a real-image FAIL test, not comparator-level proof.
- **INT-002** — a live-run artifact counts as evidence only when it measures the shipping pipeline.
- **INT-003** — a trade-offs section must appear in a graded deliverable.

**A trap the sweep hit, which will recur.** `pnpm typecheck` failed at sweep start with 7
`TS2307` errors for `fflate` and `js-yaml`. Both are declared in `package.json` and present in
the lockfile — `node_modules` was stale. `pnpm install --frozen-lockfile` fixed it in 325 ms and
changed no repo file. Had the sweep continued, TH-R4 and TH-R18 would have carried false
failures backed by real-looking command output. **Run `pnpm install --frozen-lockfile` before
trusting any red result.**

---

## 5. The verdict-miss diagnosis

`docs/diagnostics/2026-08-12-verdict-miss-triage.md`. The live eval scored 21/32 on label
verdict. All eleven misses are classified: **six are the pipeline's fault, five the corpus's.**

**Quote the accuracy as a range: 71.9% to 81.3%.** Do not go past 81.3% — three of the misses
carry ground-truth error only as a *secondary* cause, and on two of them the primary cause is a
statutory field passing on a single channel.

A stricter count that also grades the `ReviewReason` reads **18/32 = 56.25%**.

**The 65.6% is a router number, not a cascade number.** The harness reads the verdict at
`cascade-runner.ts:299-304`, before the resolver runs at `:311`. The Sonnet-only benchmark arm
*is* scored post-resolution. So the headline cascade-versus-Sonnet comparison sets two different
pipeline stages against each other. **Do not quote that benchmark's −24.1 point delta anywhere**
until TRO-538 lands.

---

## 6. The tickets — 17 in Linear, mirrored in `factory/tickets.md`

### Wave 2b — the bold rule (TRO-527..533)

The corpus cannot express 27 CFR 16.22(a)(2)'s bold requirement. Measured: every one of the 32
cases renders the prefix and body at the same weight, ratio **1.00**. A real compliant label
measures **2.2**.

### Wave 2c — fixes from the diagnosis (TRO-534..545)

### Run them in this order

```
1.  TRO-538   Urgent   Score the cascade end state.  BLOCKS TRO-516.
2.  TRO-534 ∥ TRO-535 ∥ TRO-536   The three correctness fixes. Independent.
3.  TRO-537   High     One real-image FAIL test. Lifts TH-R9 out of PARTIAL.
4.  TRO-516            Corpus corrections. Only after 538 and 535.
```

Blocked and not startable: TRO-516 (needs 538), TRO-539 (needs TRO-519), TRO-544's deployed
number (needs TRO-518; the local number is free).

### Three things that would otherwise waste a session

- **TRO-534 does not improve the score.** case-11 turns correct and case-22 turns incorrect.
  Accuracy stays 21/32. The ticket says so and forbids reporting it as a gain. **If an agent
  claims a scoreboard win there, it did something the ticket told it not to.**
- **TRO-542 must not adopt a contrast threshold** from either table in its body. Two runs with
  different parameters reached opposite conclusions. The ticket forbids it.
- **Every corpus edit waits on TRO-538.** Editing an expectation to match a router-interim
  measurement deletes a correct expectation.

---

## 7. Open decisions, and who owns them

| Decision | Owner | Notes |
|---|---|---|
| Rotate the API key | Troy | See §1 |
| Bump `render.yaml` plans | Troy | Worker carries 7 concurrent CPU-heavy loops on 0.5 CPU |
| Run a real batch on the deployed instance | Troy | Tests TRO-518 for about $0.03; see §8 |
| Publish the URL | Troy | Gated on TRO-482 |
| README and approach.md | Troy | TRO-484, TRO-485 — the two remaining MISSING rows |
| Flip the home page to batch-first | Troy | TRO-545, deferred with preconditions recorded |

---

## 8. `pnpm batch:fixture` — new, and useful next

Builds a batch upload from the golden set. Creates no new assets.

```
pnpm batch:fixture              # 32 cases: CSV 3,143 B, ZIP 1.15 MB
pnpm batch:fixture -- --count=3 # 3 cases, about $0.03, for a cheap probe
```

Output lands in `var/batch-fixture/` (gitignored). Upload both files through the batch screen.

It prints the expected tally — **8 PASS · 10 FAIL · 14 REVIEW** for the full set — so the results
screen is checkable rather than merely plausible. It also prints the caveat that 11 of those 32
missed their expectation in the live run.

**The 3-item probe is the highest-value fifteen minutes available.** It answers whether TRO-518
is real. Right now the web/worker separate-disk break is a code reading, not an observation. If
it is real, it is significant scope, and finding out now beats finding out on submission day.

---

## 9. Corrections made this session, so they are not repeated

- **A fill-ratio figure was wrong and propagated.** It was measured at tolerance 28; `imagen.ts`
  uses 20. At the real tolerance, fill ratio *does* discriminate (window 0.70, label 0.87). The
  wrong conclusion reached a ticket and a code comment before a verifier caught it. TRO-531
  carries the correction. **The lesson: when you learn a parameter was wrong, re-derive every
  conclusion that rested on it.**
- **The bold work was framed as the critical path. It is not.** TH-R9 is one small test from
  VERIFIED. The README, the approach doc and the deploy were and are the real blockers.
- **The AI-backdrop bottle track was pursued before checking scope.** `source-TH.md` never asks
  for a bottle photograph — agents review "label artwork" (L9), and the one mention of a bottle
  is hedged as "maybe out of scope for a prototype" (L34). TRO-531 records the backlog decision.
- **88 of 476 citations were wrong** across the ticket drafting, including errors in the
  diagnosis's own report. Roughly one in five detailed claims. Verify before acting on any of it.

---

## 10. Cost incurred

No Gemini spend. No Anthropic spend beyond what already existed — the eval and benchmark
artifacts read this session were already committed. Render begins billing at $24.50/month
prorated from 2026-08-12.
