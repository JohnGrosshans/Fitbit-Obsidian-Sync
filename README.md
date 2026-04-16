# Fitbit Obsidian Sync

An [Obsidian](https://obsidian.md) plugin that pulls your daily Fitbit health data (steps, sleep stages, HRV, resting heart rate, and readiness) into your vault as YAML frontmatter on a daily note — fully compatible with [Obsidian Bases](https://obsidian.md/bases), Dataview, and standard Properties.

---

## Features

- **OAuth 2.0 PKCE flow** — no third-party server; the callback is handled directly inside Obsidian via a custom URI handler.
- **Auto token refresh** — silently refreshes access tokens before they expire.
- **Frontmatter-first** — all data is written as clean YAML properties; existing note content is never overwritten.
- **Non-destructive merge** — if the note already exists, only the `fitbit_*` and `goal_*` keys are updated; your own notes stay intact.
- **Graceful degradation** — Premium-only metrics (Readiness Score) are written as `null` when unavailable, rather than erroring.

---

## Installation

### Community Plugins (recommended)

1. Open Obsidian → **Settings → Community Plugins → Browse**.
2. Search for **Fitbit Obsidian Sync**.
3. Click **Install**, then **Enable**.

### Manual

1. Download the latest release assets (`main.js`, `manifest.json`, `styles.css` if present).
2. Copy them to `<vault>/.obsidian/plugins/fitbit-obsidian-sync/`.
3. Reload Obsidian and enable the plugin under **Settings → Community Plugins**.

---

## Setup

### Step 1 — Create a Fitbit Developer App

1. Go to **[dev.fitbit.com/apps/new](https://dev.fitbit.com/apps/new)** and sign in with your Fitbit account.
2. Fill in the registration form:

   | Field | Value |
   |-------|-------|
   | Application Name | Anything (e.g. *My Obsidian Sync*) |
   | Description | Brief description |
   | Application Website URL | `https://localhost` |
   | Organization | Your name |
   | **OAuth 2.0 Application Type** | **Personal** |
   | **Callback URL** | **`obsidian://fitbit-sync-callback`** |
   | Default Access Type | Read Only |

   > **Important:** The Callback URL must be exactly `obsidian://fitbit-sync-callback`.

3. Submit the form. You will be shown a **Client ID** and **Client Secret** — copy both values.

### Step 2 — Configure the Plugin

1. In Obsidian, open **Settings → Fitbit Obsidian Sync**.
2. Paste your **Client ID** and **Client Secret** into the corresponding fields.
3. Set the **Save Path** to the folder where daily notes should be created (default: `Fitbit`).
4. Set your **Daily Step Goal** and **Weekly Cardio Goal (minutes)**.
5. Click **Connect to Fitbit** — a browser window opens for you to log in and authorize.
6. After approving access, Obsidian captures the callback automatically and stores your tokens.

### Step 3 — Sync

Open the command palette (`⌘P` / `Ctrl+P`) and run:

> **Fitbit Sync: Sync Fitbit Data for Today**

A note named `YYYY-MM-DD.md` is created (or updated) in your configured save path.

---

## Frontmatter Reference

All keys are written at the top of the note as YAML frontmatter.

| Key | Type | Description |
|-----|------|-------------|
| `fitbit_steps` | number | Total steps for the day |
| `fitbit_sleep_minutes` | number | Total sleep time in minutes |
| `fitbit_sleep_score` | number | Sleep efficiency (0–100) |
| `fitbit_sleep_stage_light` | number | Light sleep (minutes) |
| `fitbit_sleep_stage_deep` | number | Deep sleep (minutes) |
| `fitbit_sleep_stage_rem` | number | REM sleep (minutes) |
| `fitbit_sleep_stage_awake` | number | Awake time during sleep (minutes) |
| `fitbit_resting_heart_rate` | number | Resting heart rate (bpm) |
| `fitbit_sleeping_heart_rate` | number | Sleeping heart rate low zone (bpm) |
| `fitbit_hrv` | number | Daily HRV — RMSSD (ms) |
| `fitbit_readiness` | number \| null | Daily Readiness Score (Fitbit Premium only) |
| `goal_steps` | number | Your configured daily step goal |
| `goal_cardio_minutes` | number | Your configured weekly cardio goal |

### Example Note

```yaml
---
fitbit_steps: 9842
fitbit_sleep_minutes: 422
fitbit_sleep_score: 84
fitbit_sleep_stage_light: 198
fitbit_sleep_stage_deep: 72
fitbit_sleep_stage_rem: 152
fitbit_sleep_stage_awake: 21
fitbit_resting_heart_rate: 58
fitbit_sleeping_heart_rate: 52
fitbit_hrv: 41.3
fitbit_readiness: null
goal_steps: 10000
goal_cardio_minutes: 150
---

# 2025-06-01
```

---

## Using with Obsidian Bases / Dataview

Because all data is standard YAML frontmatter, you can query it directly.

**Dataview example — weekly step summary:**

```dataview
TABLE fitbit_steps, fitbit_sleep_minutes, fitbit_hrv
FROM "Fitbit"
SORT file.name DESC
LIMIT 7
```

**Obsidian Bases** will automatically pick up all `fitbit_*` properties when you point a Base at your Fitbit folder.

---

## Privacy & Security

- Tokens are stored **locally** in your vault's `.obsidian/plugins/fitbit-obsidian-sync/data.json` file. They never leave your machine except to communicate directly with Fitbit's API.
- The plugin uses Obsidian's built-in `requestUrl` for all network requests (no Node `http`/`https` modules, no `fetch` with CORS issues).
- No analytics, telemetry, or third-party services.

---

## Development

```bash
git clone https://github.com/GROSJ033/Fitbit-Obsidian-Sync
cd Fitbit-Obsidian-Sync
npm install
npm run dev     # watch mode
npm run build   # production build → main.js
```

---

## License

MIT — see [LICENSE](LICENSE).
