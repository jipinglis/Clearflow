# ClearFlow — Wastewater Treatment Project Tracker

Two static, self-contained HTML files:

- `clearflow-landing.html` — public landing page
- `clearflow-dashboard.html` — the project tracker dashboard (source of truth: the `PROJECTS` array near the top of its `<script>` block)
- `index.html` — redirects to `clearflow-landing.html` so the repo's root URL works

## What updates automatically

`.github/workflows/nightly-update.yml` runs `scripts/nightly-update.mjs` on a schedule (default: 9am US Eastern). That script:

1. Reads the current `PROJECTS`, `DELETED_IDS`, `OWNER_CONTACTS`, and `FIRM_CONTACTS` out of `clearflow-dashboard.html`.
2. Asks Claude (via the Anthropic API's web search tool) to research new or changed US wastewater treatment project activity, respecting `DELETED_IDS` as a permanent do-not-re-add list.
3. Merges any genuinely new or updated projects/contacts back into the file.
4. Commits and pushes the change back to this repo — which redeploys the GitHub Pages site automatically.

`DELETED_IDS` is never touched by the script — it's a human-only list, maintained by clicking Delete on the dashboard itself.

## One-time setup

### 1. Add your Anthropic API key as a repo secret

The nightly job needs its own Anthropic API key (get one at [console.anthropic.com](https://console.anthropic.com)):

Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**
Name: `ANTHROPIC_API_KEY`
Value: *(your key)*

Web search costs $10 per 1,000 searches plus normal token usage — for one run a day this is typically a few cents to low dollars a month depending on how much research activity there is. You can watch usage at [console.anthropic.com](https://console.anthropic.com).

### 2. Enable GitHub Pages

Repo → **Settings** → **Pages** → under **Build and deployment**, set **Source** to **Deploy from a branch**, branch `main`, folder `/ (root)` → **Save**.

Your site will be live at `https://<your-username>.github.io/<repo-name>/` within a minute or two.

### 3. (Optional) Test the nightly job manually

Repo → **Actions** → **ClearFlow Nightly Update** → **Run workflow**. Check the run log to confirm it completes and, if it found anything, pushes a commit.

## Editing the dashboard by hand

The dashboard's own Add/Delete buttons can write changes directly back to this file when opened locally in Chrome or Edge (via the File System Access API) — see the "Connect File" button in the dashboard toolbar. Once you push those local changes to GitHub, the live site picks them up automatically.

## Changing the schedule

Edit the `cron` line in `.github/workflows/nightly-update.yml`. Cron times are in UTC and GitHub doesn't adjust for daylight saving — nudge it by an hour twice a year if you want it to land at the same local time.
