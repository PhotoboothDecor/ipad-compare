# iPad Compare

A static website (the `public/` folder, hosted on Firebase Hosting, project `ipad-compare`) that ranks
used iPads by value: Geekbench 6 multi-core score divided by the price of a listing.

All data lives in one file, `public/catalog.json`. There is no database. Changing the data means
changing that file through a pull request; merging the pull request puts the new data on the live site.

## Where the data comes from

- **Models, model numbers (A-numbers), year, newest iPadOS a model can run:** Apple's own pages
  (the "Identify your iPad" page and the iPadOS compatibility guides). Checked automatically every day.
- **Scores:** Geekbench's iOS benchmark chart, https://browser.geekbench.com/ios-benchmarks. Imported by
  hand when needed (see "A 'Scores needed' issue arrived").

**Score scale.** Every score on the site is Geekbench 6 multi-core. Geekbench 7 launched on 2026-07-23 and
the public chart is now GB7 only, and it dropped iPads older than the A12. Models with a measured GB6
score keep it. A new model that only has a GB7 score is converted to the GB6 scale with a per-chip ratio
worked out from iPads that have both scores (accurate to about 1-3%) and is shown as "≈ estimated from GB7".

**Why Geekbench is not scraped automatically.** Geekbench sits behind a Cloudflare browser challenge that
no script (from GitHub or from a home computer) gets through, and the site owner does not want it
bypassed. So a person saves the page in a normal browser and the import script reads the saved file.

## What each workflow does

All three are in `.github/workflows/`.

| Workflow | When | What it does |
|---|---|---|
| `ci.yml` (CI) | Every pull request and every push to `main` | Runs the unit tests and checks `public/catalog.json` against the previous version. On a push to `main` it then deploys the site to Firebase Hosting. If tests or deploy fail on a push to `main` (not on pull requests) it opens a "Deploy failed" issue and sends a healthchecks.io fail ping. |
| `apple-check.yml` (Apple check) | Daily at 09:00 UTC, or by hand | Compares the catalog with Apple's pages. If something changed it opens or updates a pull request "Catalog update from Apple". If a new model has no score it opens or updates a "Scores needed" issue. Pings healthchecks.io at start and end; on failure it opens an "Apple check failed" issue, or comments on the one already open. |
| `keepalive.yml` | 1st of each month | GitHub switches off scheduled workflows after 60 days without repo activity. This re-enables the Apple check (and itself) so the schedules never lapse. |

## A "Catalog update from Apple" PR arrived — what now

1. Open the pull request. The description is a plain summary of what changed (new models, new model
   numbers, changed max iPadOS version, and so on).
2. Validation already ran inside the Apple check before the PR was opened. No "CI" check appears on this
   PR; that is normal (GitHub does not run checks for PRs created by its own bot). The full tests and
   validation run again when you merge, before the deploy, and a failure there sends a "Deploy failed" alert.
3. If the summary looks right, click **Merge pull request**. Merging to `main` deploys the site
   automatically (a minute or two). Check the Actions tab if you want to watch it.
4. If something looks wrong, close the PR and ask Claude to look at it. Nothing changes on the live site
   until you merge.

## A "Scores needed" issue arrived

A new model appeared on Apple's pages and has no Geekbench score yet (it shows as pending on the site).
The issue lists every model that is still pending, not just today's.

1. Merge the open "Catalog update from Apple" pull request (if there is one), then run `git pull` in the
   repo folder. The new model must be in your local `public/catalog.json` before the import can score it.
2. In Chrome, open https://browser.geekbench.com/ios-benchmarks.
3. Save the page: **Cmd+S**, Format **"Webpage, HTML Only"**, and save it somewhere easy, e.g. the Desktop.
4. In Terminal, from the repo folder (the file name below is an example):

   ```
   node scripts/import_geekbench.js ~/Desktop/ios-benchmarks.html
   ```

   Useful extras: `--dry-run` shows what would change without writing; `--captured YYYY-MM-DD` sets the
   chart's date (default is today); `--accept-large-changes` is needed only if the script refuses because
   a score moved a lot, so look at the numbers first. It also accepts a `web.archive.org` link instead of a file.
   If nothing changed it prints "No score changes" and does not touch the file.

   **"Unmatched" devices.** The script only matches a Geekbench name that is exactly one of the model's
   known names (ignoring capitals and brackets). An *unmatched* device is an iPad on the Geekbench chart that
   matches no model in the catalog. Geekbench often names an iPad differently from Apple (for example
   "iPad Air 11-inch (8th generation)" instead of "iPad Air 11-inch (M4)"). If anything is unmatched while a
   model is still pending, the script lists both, stops, and writes nothing. Fix it by opening
   `public/catalog.json`, finding the pending model, and adding the Geekbench name, exactly as printed, to that
   model's `"geekbench": []` list, for example `"geekbench": ["iPad Air 11-inch (8th generation)"]`. Then run the
   import again. If you are sure the unmatched devices are just old or irrelevant iPads, `--allow-unmatched`
   imports the rest anyway.
5. It edits `public/catalog.json`. Put that change on a branch and open a pull request (needs the `gh`
   tool, or open the PR on github.com after the push):

   ```
   git switch -c scores-YYYY-MM-DD
   git add public/catalog.json
   git commit -m "data: import Geekbench scores"
   git push -u origin HEAD
   gh pr create --fill
   ```

   CI runs on this PR; merge it when green. Or skip all this: give the saved file to Claude and ask it
   to import the scores.

## "I got an alert email / a 'failed' issue" — what now

| Message | Meaning |
|---|---|
| healthchecks.io: "missed run" / "down" | The daily Apple check did not report in. It may be switched off, GitHub may be down, or `HEALTHCHECKS_URL` is wrong. |
| healthchecks.io: "failed" (with log text) or GitHub issue "Apple check failed <date>" | The daily check ran and hit an error, usually Apple changed a page layout or was unreachable. The last 100 log lines are in the email/issue. |
| GitHub issue "Deploy failed <date>" | Tests or the Firebase deploy failed after a merge to `main`. The live site is still the previous version. |

**Logs.** The issue links to the failing run. Open it from the Actions tab: the log is on the page, and the
`apple-check` artifact (check.log and summary.md) is kept for 90 days.

**Re-run.** Open the failing run and click **Re-run all jobs**. The Apple check can also be started from
Actions → "Apple check" → **Run workflow**. If it keeps failing, give the run link to Claude.
Close the issue once things are healthy.

**Test the alerts.** Actions → "Apple check" → **Run workflow**, tick **force_fail**, run. Within a few
minutes you should get a healthchecks.io email and an "Apple check failed" issue. Close the issue afterwards.

## Local development

Needs Node 22 or newer.

```
cd scripts && npm ci && npm test      # unit tests
cd ..                                 # back to the repo root for the rest
node scripts/validate.js              # validate public/catalog.json
node scripts/smoke/smoke.mjs          # headless browser check of the site; downloads Playwright on first run
npx serve public                      # view the site at the address it prints
```

Other scripts: `node scripts/check_apple.js` (prints what Apple changed; add `--write` to apply it),
`node scripts/migrate/build_catalog.js` (one-off script that built the first catalog; its output is
reviewed in `docs/catalog-review-2026-11-19.md`). Design notes: `docs/superpowers/specs/`.

## One-time owner setup

1. **healthchecks.io.** Create an account and a check named "ipad-compare apple-check" with period 1 day
   and grace 12 hours. Add your email as the integration. Copy the check's ping URL.
   GitHub repo → Settings → Secrets and variables → Actions → New secret `HEALTHCHECKS_URL`.
2. **Firebase deploy key.** Google Cloud console, project `ipad-compare`: create a service account with the
   role **Firebase Hosting Admin**, create a JSON key, and paste its contents as repo secret
   `FIREBASE_SERVICE_ACCOUNT_HOSTING`.
3. **Let Actions open PRs.** GitHub repo → Settings → Actions → General → tick
   **"Allow GitHub Actions to create and approve pull requests"**.
4. **Email.** GitHub → Watch (on this repo) → make sure Issues notifications are delivered to email.

### Retiring Firestore (do these in this order)

The old live site still reads Firestore until the new site is deployed, so the order matters.

1. Merge the branch to `main`. Wait for the deploy to finish, then open the live site and confirm it works
   (models and scores show).
2. Only then lock Firestore (rules now deny all access). Doing it before step 1 would break the old site.
   Once: `npm install -g firebase-tools`, then `firebase login` with the Google account that owns project
   `ipad-compare`. Then, from the repo root (where `firebase.json` is): `firebase deploy --only firestore:rules`.
3. After 7 healthy days, delete the `geekbench_scores` collection in the Firebase console
   (Firestore Database). A backup is kept in `data/archive/firestore-geekbench_scores-2026-11-19.json`.
4. Delete the old `FIREBASE_SERVICE_ACCOUNT` repo secret; nothing uses it any more.
