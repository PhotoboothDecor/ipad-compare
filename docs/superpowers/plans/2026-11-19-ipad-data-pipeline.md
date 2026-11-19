# iPad Data Pipeline Rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken Firestore + daily-scrape pipeline with one validated catalog file, reliable Apple model/OS detection via reviewed PRs, on-demand Geekbench import with GB7→GB6 conversion, a tested matcher, and email alerting.

**Architecture:** `public/catalog.json` is the only data source; the site fetches it as a static file. Node scripts in `scripts/` (pure parsing/logic in `scripts/lib/`, thin CLIs on top) update it; CI validates and tests every change; merges to `main` deploy Firebase Hosting. The browser matcher moves into `public/matcher.js` (UMD) so Node tests can load it.

**Tech Stack:** Node 22, `node:test`, cheerio, ajv; vanilla JS frontend; GitHub Actions; Firebase Hosting; healthchecks.io.

**Spec:** `docs/superpowers/specs/2026-11-19-ipad-data-pipeline-design.md`

## Global Constraints

- Node 22; tests run with `node --test` from `scripts/`. No new frontend build step or framework.
- Score scale is **Geekbench 6 multi-core**. Never write GB7 numbers into `score.gb6_*` without conversion and `source: "gb7-converted"`.
- No substring/fuzzy joins in any script that writes data — exact normalized-name, topic-ID, or A-number equality only.
- Scripts never write partial data: validate the full result in memory, write only if `validateCatalog` returns no errors, else exit 1.
- Apple requests: ≥10 s apart, retry 429/5xx with 30/60/120 s backoff, User-Agent `ipad-compare-bot (+https://github.com/PhotoboothDecor/ipad-compare)`.
- Never fetch browser.geekbench.com from scripts or CI (Cloudflare challenge; owner's wishes). Input is a saved HTML file or a web.archive.org capture.
- Data changes reach `main` only through a PR; the bot never pushes to `main`.
- Firestore deletes happen only after explicit owner confirmation.

## Review Focus

1. **A-number lookup** (`A2602`, `a2602`, `Model A2602`) must return exactly one model, the right one — the current site returns iPad 2. → Task 5 test `a-number exact`.
2. **Listing with year**: "iPad Pro 11 2018" must return iPad Pro 11-inch (1st gen), not M4. → Task 5 test `year disambiguates`.
3. **Pending score** (iPad Air M4) in single add and bulk paste: shows "Score pending", excluded from value ranking, never rendered as 0.00. → Task 6 test `pending model not ranked`.
4. **Old saved comparisons** in localStorage with names that no longer exist (e.g. "iPad Air (6th)"): re-resolved via the matcher or shown as "unknown model", no crash. → Task 6 test `migrates saved rows`.
5. **Apple page change / rate limit**: a 429 storm or markup change yields exit 1 and a fail ping, with catalog.json byte-identical. → Task 3 test `parse failure writes nothing`.

---

## Catalog schema (used by every task)

```jsonc
{
  "schema_version": 1,
  "updated": "2026-11-19",            // set by any script that writes
  "latest_ipados": 27,
  "models": [{
    "id": "ipad-air-11-m4",            // ^ipad[a-z0-9-]+$, unique, slugify(name)
    "name": "iPad Air 11-inch (M4)",   // Apple's name
    "family": "air",                   // "ipad" | "air" | "mini" | "pro"
    "size_in": 11,                     // number | null
    "chip": "M4",                      // "A16", "A12X", "A17 Pro", "M4"...
    "released": 2026,                  // int 2010..current year
    "a_numbers": ["A3459"],            // ^A\d{4}$, unique across catalog
    "max_os_major": 27,                // int; iOS majors for pre-iPadOS devices
    "apple_topic_id": "g0mrwneq8sk5",  // string | null (compat-guide link suffix)
    "names": { "apple": [], "geekbench": [], "aliases": [] },
    "score_status": "ok",              // "ok" | "pending" | "unsupported"
    "score": {                         // null unless score_status == "ok"
      "gb6_multi": 13259, "gb6_single": 3700,
      "source": "gb6",                 // "gb6" | "gb7-converted"
      "gb7_multi": 13260, "gb7_single": 3235,   // int | null
      "ratio_multi": null, "ratio_single": null,  // set when gb7-converted
      "captured": "2026-07-18"
    }
  }]
}
```

`unsupported` = too old to run Geekbench 6 (iPad 1–4, iPad 2, mini 1–3, Air 1). Shared helpers live in `scripts/lib/names.js` and are duplicated nowhere: `normalizeName(s)` (lowercase, NFKC, `&nbsp;`/U+2011→space/hyphen, strip parens, collapse spaces) and `slugify(name)`.

---

### Task 1: Test harness, names helpers, catalog validator

**Files:**
- Create: `scripts/lib/names.js`, `scripts/lib/validate.js`, `scripts/validate.js` (CLI), `scripts/test/names.test.js`, `scripts/test/validate.test.js`
- Modify: `scripts/package.json` (scripts `test`, `validate`; deps `ajv`, `cheerio`; drop `axios`, `firebase-admin`; `"engines": {"node": ">=22"}`)

**Interfaces:**
- Produces: `normalizeName(s: string): string`, `slugify(name: string): string`, `validateCatalog(catalog: object, {previous?: object, now?: Date}): string[]` (empty array = valid), CLI `node scripts/validate.js [path] [--previous path]` exits 1 and prints errors.

- [ ] **Step 1: Write failing tests**
  - `slugify("iPad Air 11-inch (M4)") === "ipad-air-11-m4"`, `slugify("iPad (A16)") === "ipad-a16"`, `slugify("iPad Pro 12.9-inch (6th generation)") === "ipad-pro-12-9-6th-generation"`.
  - `normalizeName("iPad Pro 11‑inch (M4)") === "ipad pro 11-inch m4"`.
  - validateCatalog on a minimal valid fixture → `[]`; then one test per rule, each asserting the error array contains a message naming the offending id: duplicate id; duplicate A-number across two models; A-number not `^A\d{4}$`; normalized name/alias shared by two models; `score_status:"ok"` with `score:null`; `gb6_multi` in {10000, 9660, 10100, 14500}; `gb6_multi` outside 300–30000; `released` > current year; `max_os_major` > `latest_ipados`; `source:"gb7-converted"` with `ratio_multi` outside 0.8–1.2 or null `gb7_multi`; with `previous`: model count drop, or any previous id missing.
- [ ] **Step 2: Run `cd scripts && npm test`** — Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** names.js and validate.js (ajv for shape, plain JS for cross-record rules) and the CLI.
- [ ] **Step 4: Run `npm test`** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(data): catalog schema validator and name helpers`

### Task 2: Geekbench chart parser and GB7→GB6 conversion

**Files:**
- Create: `scripts/lib/geekbench.js`, `scripts/import_geekbench.js`, `scripts/test/geekbench.test.js`, fixtures `scripts/test/fixtures/gb6-2026-07-18.html`, `gb7-2026-10-31.html`, `gb7-2026-11-19.html` (copy from the session scratchpad `gb/gb6.txt`, `gb/gb7.txt`, `live/gb7_live.html`; the archived ones are already gunzipped).

**Interfaces:**
- Consumes: `normalizeName`, `validateCatalog`.
- Produces:
  - `parseChart(html: string): {version: 6|7, devices: Array<{name, chip, single, multi}>}` — iPads only; version from page text "Geekbench N" in the intro paragraph; throws if no version or < 20 iPads.
  - `chipClass(chip): "M"|"AX"|"A"` — `/^M\d/`→M, `/^A\d+[XZ]$/`→AX, else A.
  - `conversionRatio(chip, pairs, kind: "multi"|"single"): {ratio, basis: string[], spread}` — `pairs` = catalog models having both gb6 (`source:"gb6"`) and gb7. Same-chip pairs if any, else pairs of the same `chipClass` from the two highest-numbered chips. ratio = median(gb7/gb6). Throws if no pairs or `spread = (max-min)/median > 0.10`.
  - `applyChart(catalog, chart, {captured}): {catalog, report}` — matches devices to models by exact normalized name against `name` + `names.geekbench`; v6 → set measured gb6 + `source:"gb6"`; v7 → set `gb7_*` on matched models, and for models with `source !== "gb6"` (pending or already converted) set converted gb6 = round(gb7 / ratio), `source:"gb7-converted"`, `score_status:"ok"`. Unmatched iPad devices go into `report.unmatched` (never auto-created).
  - CLI: `node scripts/import_geekbench.js <file-or-wayback-url> [--captured YYYY-MM-DD] [--dry-run]` prints the report (changes, unmatched, ratios used) and writes only if `validateCatalog` passes and no score moves > 15% unless `--accept-large-changes`.

- [ ] **Step 1: Write failing tests**
  - `parseChart(gb6 fixture)` → version 6, 35 iPads, includes `{name:"iPad mini 4", multi: 603}`... (assert exact values read from fixture during implementation for 3 devices).
  - `parseChart(gb7-2026-10-31)` → version 7, 26 iPads; `gb7-2026-11-19` → 27 iPads incl. `{name:"iPad mini (A20 Pro)", chip:"Apple A20 Pro", single:3958, multi:10377}`.
  - `conversionRatio("M5", pairs, "multi").ratio` ≈ 0.968 (±0.001), basis = both M5 Pros.
  - `conversionRatio("A20 Pro", pairs, "multi")` uses A17 Pro (0.931) and A16 (0.953) → ratio ≈ 0.942; applyChart gives the A20 Pro mini `gb6_multi === 11016` (±10), `source:"gb7-converted"`.
  - A chart whose name is "iPad Air 11-inch (8th generation)" with no matching `names.geekbench` → appears in `report.unmatched`, catalog unchanged.
  - Measured `source:"gb6"` scores are never overwritten by a v7 import.
- [ ] **Step 2: Run `npm test`** — Expected: FAIL.
- [ ] **Step 3: Implement** with cheerio: tabs `#single-core` / `#multi-core`, rows `td.name a` text, `td.name .description`, `td.score`.
- [ ] **Step 4: Run `npm test`** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(geekbench): chart parser, GB7→GB6 conversion, import CLI`

### Task 3: Apple checker (models, A-numbers, max OS) → proposed changes

**Files:**
- Create: `scripts/lib/apple.js`, `scripts/check_apple.js`, `scripts/test/apple.test.js`, fixtures `apple-compat-27.html`, `apple-compat-17.html` (save live pages once).

**Interfaces:**
- Consumes: `normalizeName`, `slugify`, `validateCatalog`.
- Produces:
  - `parseIdentifyPage(html): Array<{name, a_numbers: string[], year: number}>` — iterate `h2.gb-header`; for each, collect text of following siblings until the next `h2.gb-header`; A-numbers by `/A\d{4}/g` within that slice only; year from "Year: … YYYY". Throws if < 40 models or any A-number appears under two headings.
  - `parseCompatPage(html): {version: number, models: Array<{name, topic_id}>, versions: Array<{version, url}>}` — version from `h1` /iPadOS (\d+)/ (never from the URL; unknown-version URLs silently serve the latest); models from `table[aria-label="iPad models"] a.xRef` (topic id = last `-`-separated segment of the href slug); versions from `#nojs-version-name a`. Throws if no h1 version or < 10 models.
  - `fetchApple(url): Promise<string>` — throttle/backoff per Global Constraints.
  - `diffCatalog(catalog, identify, compatPages): {changes: Change[], catalog: object}` — Change kinds: `new_model` (adds `score_status:"pending"`, `score:null`, names.apple), `a_numbers_added`, `max_os_changed`, `latest_ipados_changed`. Joins: identify → catalog by exact normalized name over `name`+`names.apple`; compat → catalog by `apple_topic_id`, fallback exact normalized name. Never removes data. Throws if a catalog model with `max_os_major ≥ 13` and `released ≥ 2015` is absent from every compat page, or if `latest_ipados` would decrease.
  - CLI `node scripts/check_apple.js [--write] [--summary out.md]`: prints/writes a markdown summary of changes (used as PR body); with `--write` writes catalog only if `validateCatalog` passes.
- [ ] **Step 1: Write failing tests** (fixtures, no network):
  - identify fixture → ≥ 46 models; "iPad Air 11-inch (M4)" present with its A-numbers; no A-number under two models; every model has ≤ 6 A-numbers.
  - compat-27 fixture → version 27; contains topic ids for "iPad mini (A20 Pro)" and "iPad Air 13-inch (M4)"; does **not** contain any name equal to "ipad"; `versions` includes 27, 26, 18, 17, 16, 15, 14, 13.
  - diffCatalog on a catalog missing Air M4 → one `new_model` change per size with `score_status:"pending"`.
  - mini 4 ends with `max_os_major: 15`, iPad 8 with 26, Pro 11 M4 with 27 (from compat fixtures for 27 and 17 + an inline mini fixture for 15 if needed).
  - `parse failure writes nothing`: CLI run against a stubbed fetch returning an HTML page with no models → exit code 1, catalog file bytes unchanged.
- [ ] **Step 2: Run `npm test`** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(apple): exact-match model/OS checker with change summary`

### Task 4: Build the initial catalog (one-off migration, owner review)

**Files:**
- Create: `scripts/migrate/build_catalog.js`, `public/catalog.json`, `data/archive/firestore-geekbench_scores-2026-11-19.json`, `scripts/test/fixtures/apple-identify-108043.html`
- Read-only inputs: Apple identify page, `https://api.appledb.dev/device/main.json`, `git show 50ce8dc:public/model_mapping.json` (pre-corruption A-numbers + aliases), the Task 2 fixtures.

**Interfaces:**
- Consumes: `parseIdentifyPage`, `parseCompatPage`, `fetchApple` (Task 3), `parseChart`, `applyChart`, `slugify`, `validateCatalog`.
- Produces: `public/catalog.json` that passes `node scripts/validate.js`.

- [ ] **Step 1: Back up Firestore** — `curl` the public REST endpoint (all pages, `pageSize=300`, key from `public/app.js:30`) into `data/archive/firestore-geekbench_scores-2026-11-19.json`; assert 129 documents.
- [ ] **Step 2: Write `build_catalog.js`**: models from `parseIdentifyPage` (Apple names, A-numbers, year); chip + `iPadX,Y` cross-check from AppleDB (disagreement → print and stop); aliases from the 50ce8dc mapping, kept only if they normalize uniquely; `apple_topic_id` + `max_os_major` from Task 3's `parseCompatPage` over all versions; pre-iPadOS-13 majors hardcoded (iPad 1→5, iPad 2→9, iPad 3→9, iPad 4→10, mini 1→9, Air 1/mini 2/mini 3→12); then `applyChart` GB6 (2026-07-18) followed by GB7 (2026-11-19). `names.geekbench` seeded from the GB6/GB7 device names using this table (Geekbench → Apple): "iPad Air 11-inch (7th generation)"→"iPad Air 11-inch (M3)", "iPad Air 13-inch (7th generation)"→"iPad Air 13-inch (M3)", "iPad (11th generation)"→"iPad (A16)", "iPad mini (7th generation)"→"iPad mini (A17 Pro)", "iPad Pro (11-inch)"→"iPad Pro 11-inch", "iPad Pro (11-inch, 4th generation)"→"iPad Pro 11-inch (4th generation)", "iPad Pro (12.9-inch, 6th generation)"→"iPad Pro 12.9-inch (6th generation)", plus any other GB name whose normalized form differs only in punctuation — the script prints every GB name it could not place and exits 1.
- [ ] **Step 3: Run it** — Expected: writes catalog; prints counts: models (~46), `ok` scores, `pending` (exactly the two Air M4s), `unsupported`, converted (exactly iPad mini A20 Pro).
- [ ] **Step 4: Run `node scripts/validate.js public/catalog.json`** — Expected: no errors. Then `node scripts/check_apple.js` (no `--write`) — Expected: "no changes".
- [ ] **Step 5: Owner review checkpoint** — produce a table (name, chip, year, max OS, GB6 multi, source) for the owner and wait for approval before committing.
- [ ] **Step 6: Commit** `feat(data): initial validated catalog; archive Firestore export`

### Task 5: Extract and fix the matcher

**Files:**
- Create: `public/matcher.js` (UMD: `window.IPadMatcher` in browser, `module.exports` in Node), `scripts/test/matcher.test.js`
- Modify: `public/app.js:234-365` (move `parseFacebookBlocks`, `cleanTitle`, `isIPadListing`), `public/app.js:709-1018` (move `findMatches`, `normalizeModelName`, `getOrdinal`)

**Interfaces:**
- Consumes: catalog schema.
- Produces: `createMatcher(catalog) → { find(query: string, limit = 10): Array<{id, name, matchType: "number"|"name"|"cpu"|"year"|"fuzzy", relevance}>, byANumber(a: string): model|null, get(id): model|null }`; `parseFacebookBlocks(text)`, `cleanTitle(raw)`, `isIPadListing(title)` exported unchanged in behavior.
- Behavior changes (vs current findMatches): query lowercased once at entry (fixes bulk path, `app.js:528`); A-numbers resolved through `byANumber` exact map first — a hit returns only that model; candidates are catalog models only (no OS-name filter needed); year matched as a 4-digit token against `released`, not whole-query `includes` (`app.js:897`); aliases matched as whole tokens; dedupe by `id`; drop the fuzzy mapping lookup (`app.js:818-825`).
- [ ] **Step 1: Write failing tests** against `public/catalog.json`: `a-number exact` (A2602, "a2602", "Model A2602" → iPad (9th generation) only); `year disambiguates` ("iPad Pro 11 2018" → top id is the 1st-gen 11-inch); "ipad air m3" → top is an M3 Air with `score_status:"ok"`; "ipad air 6" → no junk, top is an M2 Air (6th gen); "ipad mini a20" → iPad mini (A20 Pro); "ipad" alone → `[]`; a 3-listing Marketplace paste fixture (copy one used during the April smart-paste work or write one) through `parseFacebookBlocks` + `find` yields the expected ids; no result anywhere has a name starting with "iPadOS", "iOS" or "‹".
- [ ] **Step 2: Run `npm test`** — Expected: FAIL.
- [ ] **Step 3: Implement** matcher.js; app.js keeps thin wrappers calling it.
- [ ] **Step 4: Run `npm test`** — Expected: PASS.
- [ ] **Step 5: Commit** `refactor(matcher): extract testable matcher; exact A-number and year matching`

### Task 6: Switch the app to the catalog; remove Firestore from the client

**Files:**
- Modify: `public/app.js:22-134` (init + loading), `:538`, `:659`, `:872`, `:938`, `:1081-1148` (selectModel), `:1150-1240` (addResultRow), `:1375`, `:1505-1560` (leaderboard), `:1571-1599` (save/load); `public/index.html:17-20`; `firebase.json`
- Delete: `public/model_mapping.json`, `public/model_specs.json`
- Test: `scripts/test/app-data.test.js` for the pure helpers below

**Interfaces:**
- Consumes: `createMatcher`, catalog schema.
- Produces (in `public/matcher.js`, exported): `displayMaxOS(model, latest_ipados): string` ("Latest (iPadOS 27)" if equal, else "iPadOS N"; "iOS N" when N < 13); `valueOf(model, price): number|null` (null unless `score_status==="ok"` and price > 0); `migrateSaved(rows, matcher): Array<{id|null, model, price}>`.
- [ ] **Step 1: Write failing tests**: `pending model not ranked` (`valueOf(airM4, 799) === null`; leaderboard helper sorts nulls last and never labels them best); `displayMaxOS` cases (mini 4 → "iPadOS 15", Pro M4 → "Latest (iPadOS 27)", iPad 2 → "iOS 9"); `migrates saved rows` (`{model:"iPad Air (6th)"}` → id of the 6th-gen Air via `find`; `{model:"iPadOS 16.1"}` → id null, kept as "unknown model").
- [ ] **Step 2: Run `npm test`** — Expected: FAIL.
- [ ] **Step 3: Implement**: `loadCatalog()` fetches `catalog.json` (`cache: "no-cache"`); on failure the search input shows "Couldn't load iPad data — reload" (replaces the stuck-disabled state); remove Firebase SDK tags and init; rows store `data-id`, and score/value are looked up from the catalog on render, not persisted; pending rows show "Score pending"; converted scores show a "≈" badge with tooltip "Estimated from Geekbench 7"; footer shows "Scores: Geekbench 6 · data updated {catalog.updated}". `firebase.json` hosting `headers`: `Cache-Control: no-cache` for `**/*.@(json|js|css|html)`; drop `?v=10` from index.html.
- [ ] **Step 4: Run `npm test`**, then serve `public/` locally (`npx serve public`) and check in Chrome: A2602 search, "iPad Pro 11 2018", bulk paste fixture, a pending Air M4 row, reload keeps rows. Expected: all as in tests, no console errors.
- [ ] **Step 5: Commit** `feat(app): load single catalog, pending/estimated scores, drop Firestore client`

### Task 7: CI, deploy, daily Apple check, alerts; remove old pipeline

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/apple-check.yml`, `.github/workflows/keepalive.yml`, `scripts/lib/notify.sh` (optional helper)
- Delete: `.github/workflows/daily-scrape.yml`, `scripts/scrape.js`, `scripts/scrape_apple.js`

**Interfaces:**
- Consumes: `npm test`, `node scripts/validate.js`, `node scripts/check_apple.js --write --summary`.
- Secrets (owner creates): `HEALTHCHECKS_URL` (healthchecks.io check, period 1 day, grace 12 h, email integration), `FIREBASE_SERVICE_ACCOUNT_HOSTING` (service account with Firebase Hosting Admin only).

- [ ] **Step 1: `ci.yml`** — on `pull_request` and `push` to `main`: checkout@v5, setup-node@v5 (22, npm cache), `npm ci` in scripts, `npm test`, `node scripts/validate.js public/catalog.json --previous <(git show HEAD~1:public/catalog.json)` on push / base-branch file on PR. Job `deploy` (needs test, only on push to main): `FirebaseExtended/action-hosting-deploy@v0` with `channelId: live`, `projectId: ipad-compare`.
- [ ] **Step 2: `apple-check.yml`** — cron `0 9 * * *` + `workflow_dispatch`; permissions `contents: write, pull-requests: write, issues: write`; steps: curl `$HEALTHCHECKS_URL/start`; `npm ci`; `node scripts/check_apple.js --write --summary summary.md 2>&1 | tee check.log`; `node scripts/validate.js`; `peter-evans/create-pull-request@v7` (branch `auto/catalog-update`, title "Catalog update from Apple", body-path `summary.md`) when files changed; if the summary lists `new_model`, `gh issue create`/edit "Scores needed: <names>" with the import instructions; upload `check.log` + `summary.md` (`actions/upload-artifact@v4`, retention 90 days); final step `if: success()` curl `$HEALTHCHECKS_URL`; `if: failure()` curl `$HEALTHCHECKS_URL/fail` with the last 100 log lines as body, and `gh label create auto-update --force` then `gh issue create --label auto-update` (title "Apple check failed <date>", body = log tail + run URL).
- [ ] **Step 3: `keepalive.yml`** — cron monthly; `gh api -X PUT repos/${{ github.repository }}/actions/workflows/apple-check.yml/enable` (permission `actions: write`).
- [ ] **Step 4: Verify** — `actionlint` on all workflows (expected: no errors); after merge, run `apple-check` via `gh workflow run` and confirm: run green, healthchecks shows a ping, no PR when nothing changed. Then trigger a fail path once (`workflow_dispatch` input `force_fail: true` → `exit 1` before the check) and confirm the email from healthchecks and the GitHub issue arrive.
- [ ] **Step 5: Commit** `ci: validated deploy on merge, daily Apple check via PR, email alerts; remove old scrapers`

### Task 8: Retire Firestore (owner-confirmed)

**Files:**
- Modify: `firestore.rules` (deny all), `firebase.json` (keep `firestore.rules` deploy)

- [ ] **Step 1:** Confirm Task 4 Step 1 archive exists and has 129 docs.
- [ ] **Step 2:** Set rules to `allow read, write: if false;`; owner runs `firebase deploy --only firestore:rules` (needs owner login).
- [ ] **Step 3:** After 7 days with the site healthy, ask the owner to confirm, then delete the `geekbench_scores` collection in the Firebase console.
- [ ] **Step 4: Commit** `chore(firestore): deny all access; data lives in catalog.json`

### Task 9: Runbook

**Files:**
- Create: `README.md`

- [ ] **Step 1:** Document: what each workflow does; "A new iPad PR arrived — what now" (review, merge; then save the Geekbench chart in Chrome → `node scripts/import_geekbench.js file.html` → PR); local dev (`cd scripts && npm ci && npm test`, `npx serve public`); how to read an alert email; why Geekbench isn't scraped and why scores are GB6-scale.
- [ ] **Step 2: Commit** `docs: runbook`

---

## Owner setup checklist (cannot be automated)

1. healthchecks.io account → new check "ipad-compare apple-check" (1 day / 12 h grace) → email integration → copy ping URL into repo secret `HEALTHCHECKS_URL`.
2. Google Cloud: service account with *Firebase Hosting Admin* → JSON key → repo secret `FIREBASE_SERVICE_ACCOUNT_HOSTING`.
3. GitHub → Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests" ON.
4. GitHub → Watch → make sure Issues notifications go to email.
5. Delete `FIREBASE_SERVICE_ACCOUNT` secret after Task 8 (no longer used).
