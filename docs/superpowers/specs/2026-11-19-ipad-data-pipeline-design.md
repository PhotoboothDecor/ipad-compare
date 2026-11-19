# iPad Compare — Data Pipeline Rebuild (Design)

Date: 2026-11-19 · Status: approved by owner in conversation

## Problem

The daily scrape silently died on 2026-04-25 and was disabled on 2026-05-19. Root causes found:

1. Geekbench (browser.geekbench.com) sits behind a Cloudflare *managed JS challenge* — no non-browser client gets through, from CI or from home. curl-impersonate cannot solve it.
2. Geekbench 7 launched 2026-07-23; the public chart is now GB7 only. GB7 lists 27 iPads (back to A12: iPad 8 / Air 3 / mini 5); GB6 listed 35 (back to iPad mini 4 / Air 2).
3. Commit 9ff9b0d (auto-update) put every A-number (~145) on every model (`closest('div')` grabbed the whole page + two-way substring merge) and set every `max_os` to "Latest" (nav item "ipad" substring-matched every model).
4. Firestore `geekbench_scores` holds 129 docs, only 35 good: 51 junk (OS-version names, wiki template text), 7 stale duplicates, 36 unscored. Junk surfaces in search.
5. Alerts never fired (missing `auto-update` label; scrape.js has no alert path). Nothing deploys Hosting after bot commits.
6. Missing models: iPad Air 11/13-inch (M4), iPad mini (A20 Pro).

## Decisions (owner-approved)

- **Single source of truth:** `public/catalog.json`, committed and schema-validated. Firestore is retired (backed up first).
- **Score scale: Geekbench 6 multi-core.** Models with a measured GB6 score keep it. New models get a GB7 score converted to GB6 with a per-chip ratio derived from the catalog's own GB6+GB7 pairs, flagged "estimated" in the UI.
- **Scores are imported on demand**, not scraped daily: a saved Geekbench chart page (or Wayback capture) is fed to `scripts/import_geekbench.js`.
- **Apple is authoritative for model existence**, names, A-numbers, year (identify page 108043) and max OS (compat guide pages). Checked daily by CI; changes arrive as a **pull request**, never a direct commit.
- **Exact matching only** in every scraper: each model lists all names it is known by; no substring joins.
- **"Latest" is computed at render time** (`max_os_major === latest_ipados`), never stored.
- **Alerts go to email** via healthchecks.io (missed run + explicit fail ping) and GitHub issues (email notifications).
- **Merging to main deploys Hosting** after validation + tests pass.

## Evidence for the GB7→GB6 conversion

26 iPads have both scores (GB6 chart 2026-07-18, GB7 chart 2026-10-31). Multi-core GB7/GB6 ratio: median 1.002, range 0.931–1.098, and very tight within a chip: base A-series 0.93–1.00, A12X/Z 1.05–1.10, M1–M4 0.995–1.04, M5 0.96–0.97. Same-chip models agree within ~1%.

## Out of scope

User accounts, server-side storage, price scraping, Geekbench GPU (Metal) scores.
