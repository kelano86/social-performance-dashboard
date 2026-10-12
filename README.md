# Social Performance Dashboard

## What it is

A private dashboard for your own YouTube channel and Instagram account. It reads
your numbers straight from the official YouTube and Instagram APIs, stores them on
Netlify, and shows them on one page that only you (and whoever you give the
passphrase to) can open. It refreshes itself every 3 hours.

- **Overview**: a Combined / Instagram / YouTube switch that drives every card;
  headline tiles; views per day (by platform, combined, or followers vs
  non-followers); top videos by views gained in the last 24 hours, 7, 14 or 30 days;
  follower growth with daily net change.
- **Content**: every post and video in one sortable table. Click a row to open it:
  per-post stats, views over time (from snapshots taken every 3 hours) and, for
  YouTube, the audience retention curve. Above the table, a hook strength chart
  (how well each post holds viewers in its first seconds).
- **Audience**: Instagram followers by country, age and gender; YouTube traffic
  sources, views by country, viewer age and gender.
- **Schedule** (optional): upload a vertical video once and publish it to
  Instagram and YouTube at a time you pick.

Everything runs on free tiers for one person: a free Netlify account (hosting,
functions, scheduled jobs, storage), a free Google Cloud project (YouTube APIs) and
a free Meta developer app (Instagram API). No credit card is needed for any of them.

## Contents

1. [What it is](#what-it-is)
2. [What you need before starting](#what-you-need-before-starting)
3. [Step 1: Run it locally with fake data](#step-1-run-it-locally-with-fake-data)
4. [Step 2: Hosting on Netlify](#step-2-hosting-on-netlify)
5. [Step 3: Connect YouTube (Google Cloud)](#step-3-connect-youtube-google-cloud)
6. [Step 4: Connect Instagram (Meta)](#step-4-connect-instagram-meta)
7. [Step 5: Environment variables](#step-5-environment-variables)
8. [Step 6: First run](#step-6-first-run)
9. [How it works](#how-it-works)
10. [What the data can and cannot show](#what-the-data-can-and-cannot-show)
11. [Optional: the Schedule tab](#optional-the-schedule-tab)
12. [Troubleshooting](#troubleshooting)
13. [Scripts reference](#scripts-reference)

---

## What you need before starting

- **Node.js 20 or newer** and **git** on your computer. (The automated tests need
  Node 22.18 or newer; nothing else does.)
- **A Netlify account** (free). It hosts the site and runs the background jobs.
- **A GitHub account** if you want Netlify to redeploy on every push (recommended).
- **The Google account that owns your YouTube channel.**
- **A Google Cloud account.** Any Google account can open the Google Cloud
  console. You do not need to add billing for the YouTube APIs.
- **An Instagram professional account** (Business or Creator) **connected to a
  Facebook Page.** A personal Instagram account cannot be read through the API.
- **A Meta developer account** (free, at developers.facebook.com, using your
  Facebook login).

Why so many accounts? Neither YouTube nor Instagram lets a dashboard read your
statistics on its own. Each platform only hands your data to a "developer app" that
you create and then authorise with your own login. So you make one small Google
Cloud project and one small Meta app, sign in to each once, and the dashboard uses
the tokens they give you. Nothing is shared with anyone else: the app, the tokens
and the data are all yours.

---

## Step 1: Run it locally with fake data

This shows you the whole dashboard on your computer in a couple of minutes, with
invented numbers and no accounts.

```bash
git clone <your copy of this repo> social-performance-dashboard
cd social-performance-dashboard
npm install
node scripts/make-fixture.mjs
node scripts/dev-server.mjs 5310
```

Open http://localhost:5310 in your browser. Every account name, title and number
you see is synthetic (from `scripts/make-fixture.mjs`, which uses a seeded random
generator, so you get the same data every time). The local server has no
passphrase, the Refresh button does nothing, and the Schedule tab only shows an
empty queue. Stop it with Ctrl+C.

Optional: `npm test` runs the automated tests (Node 22.18+). They use fake APIs
and never touch the network.

---

## Step 2: Hosting on Netlify

### Why Netlify

One free Netlify account gives this project everything it needs, so nothing else has
to run anywhere:

- the **static site** (the `public/` folder),
- **serverless functions** (the API the page calls, in `netlify/functions/`),
- **scheduled functions**, which are cron jobs (the 3-hourly refresh, the 6-hourly
  details job, the 15-minute publisher),
- **background functions** for longer jobs,
- **Netlify Blobs**, a small key-value storage where the data, history and
  snapshots live. It needs no setup.

The limits that matter for this project:

- A **scheduled function** has **30 seconds**. The 3-hourly refresh must fit in that.
  For a typical personal account it does (see [Troubleshooting](#troubleshooting)
  if yours grows very large).
- A **background function** has **15 minutes**. The slow jobs (per-post details,
  Instagram's daily history, publishing a video) run as background functions.
- **Function invocations**: this project makes a few thousand a month (8 refreshes
  and 4 details runs a day, plus a publish check every 15 minutes, plus your own
  page loads). That is far inside the free plan's monthly allowance. Check
  Netlify's pricing page for the current numbers.

### Option A (recommended): deploy from your own GitHub repo

1. Put the code in your own GitHub account. Either **fork** this repo, or create a
   new repository and push a copy of it. A fork of a public repo is public too.
   That is fine, because no secrets ever live in the repo: they live in Netlify's
   environment variables. If you prefer a private repo, create an empty private
   repository and push your clone to it.
2. In Netlify: **Add new project → Import an existing project → GitHub**. Authorise
   Netlify on GitHub if asked, then pick your repository.
3. Build settings: leave them as Netlify fills them in. They come from
   `netlify.toml`: publish directory `public`, functions directory
   `netlify/functions`, and a build command that only prints a message (there is
   nothing to compile). Netlify installs the npm dependencies and bundles the
   functions by itself.
4. Click **Deploy**. The first deploy takes a minute or two.

From now on, every push to the `main` branch redeploys the site automatically.

### Option B: deploy from your computer with the Netlify CLI

No GitHub needed. From the project folder (after `npm install`):

```bash
npx netlify-cli login            # opens the browser to authorise the CLI
npx netlify-cli deploy --prod    # first run: choose "create and configure a new project"
```

The first `deploy` asks whether to link an existing Netlify project or create a new
one. Create one. Later deploys go straight to the same project. Run
`npx netlify-cli deploy --prod` again whenever you change the code.

If you would rather have Git-based deploys set up from the terminal, run
`npx netlify-cli init` instead (it needs the folder to be a Git repo with a GitHub
remote).

### Where settings live

- **Environment variables**: in the Netlify project, **Project configuration →
  Environment variables**. All tokens and settings go here (the full list is in
  [Step 5](#step-5-environment-variables)).
- **Redeploy after changing an environment variable.** Functions only see the new
  value after the next deploy: **Deploys → Trigger deploy**, or push a commit, or
  run `npx netlify-cli deploy --prod`.
- **Secret values**: tick "Contains secret values" for real credentials. Netlify then
  scans every deploy for those values and fails the build if one appears in a file.
  Two rules keep that scan happy:
  1. Never mark a non-secret value as secret. A timezone such as `UTC`, or a word
     like `facebook`, appears in the code itself, so marking it secret fails every
     build.
  2. Never paste a real credential into any file in the repo, including this README
     or a comment. Keep them only in Netlify and in your local `.env.local` (which is
     gitignored).
- **Scheduled functions only run on the production deploy.** Deploy previews and
  branch deploys never run the cron jobs.

### Your site's address and the passphrase

Netlify gives every project a free web address on its own domain. You find it at the
top of the project's overview page in Netlify (you can change the first part under
**Project configuration → General → Project details → Change project name**).

When you open the site for the first time it asks for a passphrase. That is the value
you set as `DASH_KEY` (see [Step 5](#step-5-environment-variables)). Your browser
remembers it after the first time. Until the YouTube and Instagram steps below are
done there is no data yet, so the page will say so.

---

## Step 3: Connect YouTube (Google Cloud)

You create a Google Cloud project, allow it to use the two YouTube APIs, and sign in
once with the account that owns the channel. A setup script turns that sign-in into
a long-lived "refresh token" the dashboard can use.

### 3a. Create the project and enable the APIs

1. Open https://console.cloud.google.com/ and sign in.
2. Project picker (top left) → **New project**. Any name, for example
   "social dashboard". Create it and make sure it is selected.
3. **APIs & Services → Library**. Search for and **Enable** both:
   - **YouTube Data API v3**
   - **YouTube Analytics API**

### 3b. Configure the OAuth consent screen

Google now calls this section **Google Auth Platform** (older consoles call it
**APIs & Services → OAuth consent screen**).

1. **Branding**: app name (anything, for example "My social dashboard"), your email
   as the support and developer contact. Save.
2. **Audience**: user type **External**.
3. Still on **Audience**, click **Publish app** and confirm, so the status reads
   **In production**.
   - Why: while an app is in **Testing**, Google expires its refresh tokens after
     **7 days**, and the dashboard would stop updating every week.
   - Alternatively you can stay in Testing and add your own Google account under
     **Test users**, but then you must redo step 3d every week. Publishing is easier.
   - Publishing does not make anything public. Only people who sign in to your app
     ever grant it access, and that is only you.
4. **Data access** (optional): you can add the scopes listed below. The setup script
   asks for them at sign-in anyway.

### 3c. Create the OAuth client

1. **Clients → Create client** (older consoles: **Credentials → Create credentials →
   OAuth client ID**).
2. Application type: **Web application**.
3. Under **Authorised redirect URIs**, add exactly:

   ```
   http://localhost:5320/callback
   ```

   This is the address the setup script listens on (it also prints it when it runs).
4. Create it. Copy the **Client ID** and the **Client secret** now. (Google may only
   show the full secret at creation time. If you lose it, add a new secret to the
   same client.)

### 3d. Get the refresh token

In the project folder on your computer, create a file named `.env.local` (it is
gitignored, never commit it) with:

```
GOOGLE_CLIENT_ID=paste-your-client-id
GOOGLE_CLIENT_SECRET=paste-your-client-secret
```

Then run:

```bash
node scripts/setup-tokens.mjs google
```

It prints a Google sign-in link. Open it and sign in with **the Google account that
owns the YouTube channel** (if the channel is a Brand Account, pick the channel when
Google asks).

You will see **"Google hasn't verified this app"**. That is expected for a personal
app you made yourself. Click **Advanced → Go to (your app name) (unsafe)**, then allow
the requested access. The browser then shows "Authorised" and the script writes
`GOOGLE_REFRESH_TOKEN` into `.env.local`. It never prints the token.

`node scripts/setup-tokens.mjs check` shows which values `.env.local` has, masked.

### 3e. Copy the values to Netlify

Add these three to Netlify (**Project configuration → Environment variables**), each
marked as secret, then redeploy:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`

### Scopes: what each feature needs

| Scope | Asked for by | Used for |
|---|---|---|
| `youtube.readonly` | `setup-tokens.mjs google` | Channel, video list, titles, lifetime view counts |
| `yt-analytics.readonly` | `setup-tokens.mjs google` | Daily views, watch time, retention, traffic sources, countries, age, gender, subscribers gained and lost |
| `youtube.upload` | `setup-tokens.mjs google --upload` | Only the Schedule tab's YouTube half (uploading videos) |

The dashboard itself only needs the two read-only scopes. Add `--upload` only if you
want to publish to YouTube from the Schedule tab. (`youtube.force-ssl` would also
allow uploads, but it grants full control of the channel, which this project does not
need.) If you add `--upload` later, rerun the script and replace
`GOOGLE_REFRESH_TOKEN` in Netlify.

**Important for the Schedule tab:** Google keeps every video uploaded through an API
project that has not passed YouTube's API compliance audit **private**, whatever
privacy the upload asks for. Your new project has not been audited, so videos the
Schedule tab sends to YouTube will stay private until you apply and pass the audit:
https://support.google.com/youtube/contact/yt_api_form. Reading your statistics
needs no audit.

---

## Step 4: Connect Instagram (Meta)

### 4a. Make sure the Instagram account can be read

1. In the Instagram app: **Settings → Account type and tools → Switch to professional
   account** (Business or Creator). Skip if it already is one.
2. Connect it to a **Facebook Page** you manage. In Instagram: **Edit profile →
   Page** (or from the Page's settings in Facebook, under linked accounts). If you
   do not have a Page, create one; it can be empty.

The API reaches your Instagram account *through* that Page, which is why it is needed.

### 4b. Create the Meta app

Meta renames these screens from time to time. The permission names are what matter.

1. Go to https://developers.facebook.com/apps and click **Create app**.
2. Give it a name and your contact email.
3. Use case: **Manage messaging & content on Instagram**. You do not need to connect
   a business portfolio.
4. Create the app. In its dashboard, open the use case (**Use cases → Customize**)
   and choose **API setup with Facebook login**.
5. Add these permissions:
   - `instagram_basic`
   - `instagram_manage_insights`
   - `pages_read_engagement`
   - `pages_show_list`
   - `instagram_content_publish`, only if you will use the Schedule tab
   - `instagram_manage_comments` is optional and not used by the dashboard
6. **App settings → Basic**: copy the **App ID** and the **App secret** (click Show).

You do **not** need App Review. The app stays in development mode, and in development
mode every permission works for the people who have a role on the app. You created
it, so you are its admin, and it can read your own account.

### 4c. Get a 60-day token

1. Open the Graph API Explorer: https://developers.facebook.com/tools/explorer/
2. **Meta App**: pick your app. **User or Page**: **User Token**.
3. Add the same permissions as above, then **Generate Access Token**. In the login
   window, select your Facebook Page and your Instagram account.
4. Copy the token. It only lasts about an hour, so do the next step right away.

Add three lines to `.env.local`:

```
META_APP_ID=paste-your-app-id
META_APP_SECRET=paste-your-app-secret
META_SHORT_TOKEN=paste-the-token-from-the-explorer
```

Then run:

```bash
node scripts/setup-tokens.mjs meta
```

It exchanges the short token for a **60-day** token, writes it to `.env.local` as
`META_ACCESS_TOKEN` (never printed), clears `META_SHORT_TOKEN`, and also writes
`META_AUTH=facebook`. You do not need to copy `META_AUTH` to Netlify: the code
detects it on its own.

### 4d. Copy the values to Netlify

Add these three to Netlify, each marked as secret, then redeploy:

- `META_APP_ID`
- `META_APP_SECRET`
- `META_ACCESS_TOKEN`

### The 60-day renewal

The Instagram token lasts 60 days, and once it has expired it cannot be renewed: you
have to authorise again. So renew it **before** it runs out:

1. Repeat [4c](#4c-get-a-60-day-token) (new short token in the Graph API Explorer, then
   `node scripts/setup-tokens.mjs meta`).
2. Replace `META_ACCESS_TOKEN` in Netlify and redeploy.

The dashboard tells you when. The footer shows **META TOKEN nD LEFT** (this needs
`META_APP_ID` and `META_APP_SECRET` in Netlify, because the check asks Meta about the
token with the app's credentials). From 14 days left, every refresh also adds a
warning, which shows as "1 partial" in the footer and in the function log.

The Google refresh token does not expire as long as the consent screen is **In
production**, you use it at least once every six months, and you do not revoke the
app's access in your Google account.

---

## Step 5: Environment variables

Everything the code reads, all set in Netlify under **Project configuration →
Environment variables**. Redeploy after any change.

| Variable | Needed for | Required? | Mark as secret? | Notes |
|---|---|---|---|---|
| `GOOGLE_CLIENT_ID` | YouTube | Required for YouTube | Yes | From [Step 3c](#3c-create-the-oauth-client). |
| `GOOGLE_CLIENT_SECRET` | YouTube | Required for YouTube | Yes | From Step 3c. |
| `GOOGLE_REFRESH_TOKEN` | YouTube | Required for YouTube | Yes | From `setup-tokens.mjs google`. |
| `META_ACCESS_TOKEN` | Instagram | Required for Instagram | Yes | 60-day token from `setup-tokens.mjs meta`. |
| `META_APP_ID` | Token countdown | Recommended | Yes | Lets the footer show the days left on the Meta token and warn before it expires. |
| `META_APP_SECRET` | Token countdown | Recommended | Yes | Same as above. |
| `DASH_KEY` | Passphrase | Strongly recommended | Yes | See below. Without it, anyone with the link can read the dashboard, and **Refresh now** and the Schedule tab are disabled. |
| `DASH_TZ` | Day boundaries | Optional (default `UTC`) | **No** | An IANA time zone name such as `Europe/London` or `America/New_York`. Sets where a day starts for "views gained per day" (the bars in each row's drop-down and the Combined by day breakdown). Other charts use the dates the platforms report. |
| `META_AUTH` | Instagram | Optional, leave unset | **No** | `facebook` or `instagram`. Skips the auto-detection of which kind of Meta login the token came from. |
| `IG_USER_ID` | Instagram | Optional | **No** | Your Instagram account's numeric id. Skips looking it up through your Facebook Pages. Only useful if that lookup fails (see Troubleshooting). |
| `URL`, `DEPLOY_PRIME_URL` | Cron handoffs | Set by Netlify | n/a | Netlify provides these automatically. Do not set them. |

You need at least one platform configured. If only one is, the dashboard runs with
that one and the footer says the other is not connected.

`META_SHORT_TOKEN` only ever lives in your local `.env.local`, for the setup script.
Netlify does not need it.

**About `DASH_KEY`.** It is a shared passphrase, checked on the server before any data
is returned. Pick a long random one, for example:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

It is a deterrent, not real authentication: there are no user accounts and no rate
limiting, the browser stores it after the first entry, and it travels in a request
header. It stops someone who finds the link from reading your analytics. It is not
what you would put in front of other people's data. Never share a link that contains
`?k=` (the passphrase can also be passed that way).

**The Netlify secret-scan trap, again.** Mark only the real credentials as secret.
Leave `DASH_TZ`, `META_AUTH` and `IG_USER_ID` unmarked: values like `UTC` or
`facebook` appear in the code, so the scan would find them and fail every build. And
never paste a real value into a file that gets deployed, including docs. If a deploy
fails the scan, the deploy log names the exact file and line.

---

## Step 6: First run

1. Open your site. Enter the passphrase (`DASH_KEY`).
2. The page says no data is cached yet. Click **Refresh now**. It pulls both
   platforms (this can take up to about half a minute) and then shows the dashboard.
3. From now on the scheduled refresh runs every 3 hours by itself (at :00, in UTC).
4. The **details** job runs every 6 hours (at :30). It fetches the per-post stats in
   each row's drop-down, Instagram's follower / non-follower split, and Instagram's
   follows and unfollows. To run it now instead of waiting:

   ```bash
   curl -X POST -H "x-dash-key: YOUR_DASH_KEY" https://YOUR-SITE/.netlify/functions/details-background
   ```

   It answers `202` straight away and works in the background for up to a few
   minutes. Then click **Refresh now** once more so the overview picks up the split.

What fills in over time:

- **Views over time** for each post, and **Top videos by views gained**, are built
  from snapshots the dashboard takes on every refresh. History starts at your first
  refresh, and no API can backfill it. "Views gained in 24 hours" needs about a day of
  snapshots, 30 days needs about a month. Until then the cards say they are partial.
  Posts published before tracking began get a dashed estimate line.
- **Follower growth**: neither platform reports historical follower counts. The
  dashboard records a measured count every day from now on, and reconstructs earlier
  days from daily follower changes (see the next section). YouTube's reconstruction
  goes back 90 days.
- **Instagram follower history** before the details job has run uses Instagram's
  "new followers" figure, which ignores unfollows, so it reads a little low. Once the
  details job has fetched follows and unfollows (up to 90 days back), those days show
  a true net.
- **Instagram per-reel metrics**: Instagram gives reels their views, reach, likes,
  comments, saves, shares, skip rate and watch time, and in the drop-down only
  reposts. Follows gained and profile visits exist for feed posts only, so a reel's
  drop-down does not show them.
- **YouTube** analytics run 2 to 3 days behind. A new video shows its live view count
  straight away, with the other figures as "—" until YouTube reports them.

---

## How it works

```
YouTube Data + Analytics APIs ┐
                              ├─> refresh (every 3 h) ─> Netlify Blobs ─> /api/data ─> the page
Instagram Graph API           ┘
                                  details (every 6 h) ─> Netlify Blobs ─> /api/details
```

Credentials are only ever read on the server, from Netlify's environment variables.
The browser never sees them.

| Piece | File | What it does |
|---|---|---|
| Scheduled refresh | `netlify/functions/refresh.mts` | Every 3 hours (`netlify.toml`). Pulls both platforms, shapes the data, stores it, appends today's follower counts, records a view snapshot. Must finish in 30 s. |
| Manual refresh | `netlify/functions/refresh-now.mts` | `POST /api/refresh`, the Refresh now button. Same pull. Needs `DASH_KEY`. |
| Read | `netlify/functions/data.mts` | `GET /api/data`: the stored dataset. Passphrase-gated. |
| View history | `netlify/functions/snapshots.mts` | `GET /api/snapshots`: one post's views over time, or one day's views gained. |
| Post details | `netlify/functions/details.mts` | `GET /api/details`: one post's extra stats for its drop-down. |
| Details job | `details-tick.mts` → `details-background.mts` | Every 6 hours. The tick (30 s) hands off to a background function (15 min) that fetches per-post details and Instagram's daily history. |
| Scheduler | `schedule.mts`, `upload.mts`, `media.mts`, `publish-tick.mts` → `publish-run-background.mts` | The Schedule tab: upload in chunks, store the queue, serve the video at a public URL, publish due posts every 15 minutes. |
| YouTube client | `netlify/lib/google.mjs` | Data API v3 + Analytics API v2. |
| Instagram client | `netlify/lib/meta.mjs` | Graph API. Detects which kind of Meta login the token belongs to. |
| Platform collection | `netlify/lib/sources.mjs` | Runs both clients in parallel; skips a platform with no credentials. |
| Shaping | `netlify/lib/shape.mjs` | Normalises both platforms into one payload, pairs cross-posts, reconstructs follower history. |
| Snapshots | `netlify/lib/snapshots.mjs` | Records lifetime views per post on every refresh; computes views gained. |
| Instagram daily cache | `netlify/lib/igdaily.mjs` | Stores finished days of Instagram's daily figures so the refresh does not ask again. |
| Passphrase | `netlify/lib/auth.mjs` | The `DASH_KEY` check. |
| Page | `public/` | Plain HTML, CSS and JavaScript. Hand-drawn SVG charts, no framework, no build step. |

**Storage (Netlify Blobs).** Store `social-dashboard` holds `latest` (the dataset),
`history` (daily follower counts), `snaps/YYYY-MM` (view snapshots, one blob per
month), `ig-daily/YYYY-MM` (Instagram's daily cache) and `details/latest`. Store
`social-schedule` holds the queue and `social-media` the uploaded videos. Deploy
previews get their own separate stores, so testing never touches your real data.

**Quotas.** YouTube's API quota is 10,000 units a day and this uses a small fraction.
Instagram is called with limited concurrency to stay clear of Meta's rate limits.

**Cost of the history.** One snapshot is about 4.6 KB for 100 Instagram posts and 20
videos, so a month of snapshots at 8 refreshes a day is about 1.1 MB.

**Changing the schedule.** The cron expressions are in `netlify.toml`. For example
`schedule = "@hourly"` for the refresh. Commit and redeploy.

---

## What the data can and cannot show

Worth knowing before reading anything into a chart.

**Views are not comparable across platforms.** Instagram counts plays, including
replays, with no minimum watch time. YouTube counts a view on its own threshold and
changed how Shorts are counted in March 2025. The combined total adds two different
units. It is shown because it is useful as a trend, not because it is one measure.

**Retention curves: YouTube yes, Instagram no.** YouTube reports a retention curve per
video (the share still watching at each point), shown in the video's drop-down for
the 12 most viewed public videos with at least 100 views. Instagram's API has no
retention curve at all. Its skip rate (the share who left within the first 3 seconds)
is the closest stand-in, so the Hook strength chart plots 100 minus the skip rate for
reels and YouTube's average percentage viewed for videos. Taller is better on both.

**Follower history is part measured, part reconstructed.** Neither API returns past
follower counts, only today's. So:

1. *Measured*: every refresh records today's count. Accurate, but only from your first
   refresh onward.
2. *Reconstructed*: today's count walked backwards through each day's follower change,
   for the days before that.

| Platform | Daily change used | Fidelity |
|---|---|---|
| YouTube | Subscribers gained minus subscribers lost | True net change. Accurate. |
| Instagram, days the details job has fetched (up to 90) | Follows minus unfollows | True net change. The tooltip shows both. |
| Instagram, other days | New followers only (no unfollows) | Gross adds. Earlier levels read too low and growth looks steeper than it was. An estimate. |

Both platforms only return rows for days with movement, so a missing day means no
change. The reconstruction stops at the earliest day each source covers rather than
drawing a flat line further back. Instagram's "new followers" figure only covers the
last 29 days.

**YouTube analytics lag 2 to 3 days.** The YouTube line stops short of Instagram's.
The chart notes say how far each platform has reported, so a short line reads as a
delay, not a drop to zero.

**A new YouTube upload has two view counts.** The Analytics API reports `0` for a
video inside its reporting delay, while the Data API's lifetime count is live. The
dashboard takes the larger. Analytics figures for such a video (average percentage
viewed, watch time, subscribers gained) show as "—" rather than a misleading zero.

**New Instagram posts report zeros, not blanks**, until Instagram has computed them. A
reel with views but zero reach is treated as "not computed yet", so it does not show a
perfect 0% skip rate.

**Only public YouTube videos are shown.** The Analytics API also returns private and
unlisted videos, which would inflate every count.

**Instagram media is limited to the last 2 years** (and at most 200 posts).
Posts from before an account became professional return no insights.

**Views gained are differences between snapshots.** Instagram only gives each post's
lifetime total, never a per-post time series, so views gained over any window is the
difference between two snapshots. Rules: a post missing from the earlier snapshot
counts its whole total only if it was published after that snapshot; otherwise it is
left out (and the note says how many). A count the platform revised downwards shows
as no gain. The account's own daily views for the same days are shown alongside as a
reference.

**Cross-posted releases are paired by date.** In "Combined by day", a YouTube video
and an Instagram post published within a day of each other are treated as one
release. That is a heuristic, not an identifier, so each row names its pieces.

**Some Instagram figures may not be available for every account.** The follower /
non-follower split of views and the daily follows and unfollows are requested
defensively. If Instagram rejects one, the details job drops it for that run, logs one
warning, and the related chart says the data is not available. Instagram's audience
demographics (country, age, gender) need at least 100 followers. YouTube's age and
gender breakdowns can stay empty on small channels.

---

## Optional: the Schedule tab

Upload a vertical video once, write a caption (and an optional YouTube title), pick a
time and the platforms, and the dashboard publishes it.

What it needs:

- `DASH_KEY` set (uploading and scheduling are passphrase-gated).
- **Instagram**: the `instagram_content_publish` permission in your Meta token (add
  it in [4b](#4b-create-the-meta-app) and [4c](#4c-get-a-60-day-token), then replace
  `META_ACCESS_TOKEN`).
- **YouTube**: a refresh token with the `youtube.upload` scope
  (`node scripts/setup-tokens.mjs google --upload`, then replace
  `GOOGLE_REFRESH_TOKEN`), **and** a passed YouTube API compliance audit. Without the
  audit, Google keeps every video your project uploads private. Apply here:
  https://support.google.com/youtube/contact/yt_api_form

How it works:

- The video uploads in 4 MB chunks (Netlify caps a request body at about 6 MB) and is
  stored in Netlify Blobs, up to 400 MB.
- Instagram cannot schedule natively and publishes by fetching a video from a URL. So
  the video is served at a public, unguessable address (`/media/<random id>`), and a
  cron (`publish-tick`, every **15 minutes**, production deploys only) publishes
  whatever is due. A post set for 18:00 goes out between 18:00 and 18:15. Treat an
  uploaded video as public from the moment you upload it.
- The publishing itself runs in a background function, because Instagram's
  processing of a video often takes longer than 30 seconds.
- A platform that fails is retried on the next runs, up to 3 attempts. The queue
  shows the reason Instagram or YouTube gave.
- Instagram reels want MP4, vertical, and within Instagram's length limits. It
  rejects anything outside its spec at publish time.
- Uploaded files are kept in the `social-media` blob store. The code does not delete
  them after publishing.

---

## Troubleshooting

**A token expired.**
- Instagram: errors like "Error validating access token" or "Session has expired".
  Redo [4c](#4c-get-a-60-day-token), replace `META_ACCESS_TOKEN` in Netlify, redeploy.
  Watch the footer countdown so it does not happen again.
- YouTube: "Google token refresh failed: 400 invalid_grant". The refresh token was
  revoked, or the consent screen was still in **Testing** (7-day tokens), or it was
  unused for six months. Publish the consent screen, rerun
  `node scripts/setup-tokens.mjs google`, replace `GOOGLE_REFRESH_TOKEN`, redeploy.

**"Could not load data: no data cached yet".** No refresh has run since this deploy's
data store was created. Click **Refresh now**, or wait for the next scheduled run.

**"manual refresh disabled: DASH_KEY is not set on this site".** Set `DASH_KEY` and
redeploy.

**The refresh fails with "No platform is configured".** The environment variables are
missing or the site was not redeployed after adding them.

**"Token did not resolve to an Instagram account".** The Instagram account is not a
professional account, is not linked to a Facebook Page, or the token is missing
`pages_show_list`. If your Page belongs to a Meta business portfolio and the lookup
still finds nothing, find your Instagram account's id in the Graph API Explorer
(query `me/accounts?fields=instagram_business_account`) and set it as `IG_USER_ID`.

**Empty charts.**
- "Not enough daily data yet", "Building history" or "Collecting": give it a few
  refreshes. View history only starts at your first refresh.
- "No follower split yet": the details job has not run yet. Wait up to 6 hours or
  trigger it (see [Step 6](#step-6-first-run)).
- Audience cards empty: Instagram demographics need 100+ followers; YouTube age and
  gender need enough viewers.
- The footer says "1 partial" (or more): some optional request failed. The function
  log (Netlify: **Logs → Functions**, then `refresh` or `details-background`) lists
  each warning.

**Scheduled functions never run.** They only run on the **published production
deploy**: not on deploy previews, not on branch deploys, and not locally. Check the
`refresh` function's log in Netlify after the next :00 UTC.

**The deploy fails the secret scan.** A value marked secret appears in a file. Either
a non-secret was marked secret (`DASH_TZ`, `META_AUTH`, `IG_USER_ID` should not be),
or a real value was pasted into the repo. The failed deploy log names the file and
line. Fix it, then redeploy.

**The refresh times out (30 seconds).** The footer shows how long the last pull took
(`PULL ...MS`). A typical personal account finishes well inside 30 seconds, and the
Instagram daily cache makes later refreshes faster. To check before deploying, run
`node scripts/test-direct.mjs` locally (it uses `.env.local` and prints timings). For a
very large account, lower `MEDIA_WINDOW_DAYS` in `netlify/lib/meta.mjs` (how far back
posts are read) or the number of retention curves in `netlify/lib/google.mjs`.

**Changed an environment variable and nothing happened.** Redeploy. Functions read
environment variables at deploy time.

---

## Scripts reference

| Command | What it does |
|---|---|
| `node scripts/make-fixture.mjs` | Writes synthetic data to `.local/` for the local dev server. |
| `node scripts/dev-server.mjs 5310` | Serves the dashboard locally on port 5310 from that synthetic data. |
| `node scripts/setup-tokens.mjs google` | Signs in to Google and writes `GOOGLE_REFRESH_TOKEN` to `.env.local`. Add `--upload` for the Schedule tab. |
| `node scripts/setup-tokens.mjs meta` | Exchanges a short Meta token for a 60-day `META_ACCESS_TOKEN` in `.env.local`. |
| `node scripts/setup-tokens.mjs check` | Shows which values `.env.local` has, masked. |
| `node scripts/test-direct.mjs [google\|meta]` | Pulls your real data with `.env.local` and prints counts and timings. Writes `.local/direct.json` (gitignored; it holds your real numbers, keep it local). |
| `npm test` | Runs `scripts/test-snapshots.mjs` and `scripts/test-details.mjs` against fake APIs (Node 22.18+). |
| `node scripts/test-details.mjs --timing 500` | Simulated request counts and timings per run, with every fake request taking 500 ms. |

`.env.local` and `.local/` are gitignored. Never commit them.
