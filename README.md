![Heads Up News — Telegram AI news digest for Even Realities G2 glasses](banner.png)

# Heads Up News — Telegram AI news digest for Even Realities G2

Built for the **Even Realities 'Heads Up' Hackathon** (23–29 Nov 2026), **Messaging & News track**, by SIERA Labs. Also targeting the **$1,000 Best Telegram Integration** bonus.

## The problem

News is built for phones. On smart glasses you get a 576×288 glance — a
firehose of headlines is unreadable, and reading without acting is a dead
end. People miss the day's important stories because checking the news
means stopping what they're doing and pulling out a phone.

## What it does

**Heads Up News** is an AI-agent news digest that lives in two places:

1. **On your G2 glasses** — one story at a time, glanceable: a short
   headline plus a one-sentence summary. Scroll the R1 ring to pick an
   action, tap to run it:
   - **Next story ▶** — advance the digest.
   - **★ Save to Telegram** — the full story (headline, summary, source,
     link) is sent to your Telegram chat by `@HeadsUpNewsBot`.
   - **🎤 Voice command** — tap, then say **"next"**, **"save this"** or
     **"repeat"**. The glasses mic records ~4s of audio, the backend
     transcribes it with Deepgram and runs the command. Ring + tap always
     keep working — voice is additive, never a replacement.
   - Double-tap anywhere exits.
2. **In Telegram** — `/digest` from `@HeadsUpNewsBot` sends the full
   AI-written digest, and anything you save on the glasses lands in the
   same chat. The glasses are for glancing; Telegram is for reading.

The digest itself is written by an AI agent: every 30 minutes the backend
pulls world-news RSS (BBC, The Guardian, Al Jazeera, The Verge), dedupes
and ranks by recency, and asks GLM (via the 0G router) to pick the 8 most
important stories and rewrite each to a ≤10-word headline and a ≤18-word
summary. If the model call fails, the backend shows shortened RSS
headlines with source links, without copying descriptions into summaries.

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/architecture-dark.png">
  <img alt="Heads Up News architecture. Users: a Telegram user in their own chat with the bot, and a G2 glasses wearer using ring + tap, voice and save to Telegram. Run by SIERA: the G2 app (g2-app/src/main.ts, on the glasses, Even Hub SDK) calls headsup.sieralabs.com over HTTPS for /api/digest, /api/save and /api/voice, through Cloudflare (proxied DNS) to Traefik; Traefik on the SIERA VPS terminates TLS and routes over Tailscale to port 8787 on the 32GB droplet; the Telegram bot backend (backend/server.mjs, Node 22 or later, zero npm dependencies, state in state.json) runs there; the voice poller (voice-poller/deepgram_poller.py) also runs on the 32GB droplet, reads the Deepgram key from a mode-600 file, polls the backend directly on port 8787 for voice jobs and posts transcripts back. Third-party services: the Telegram Bot API (getUpdates long polling, sendMessage as plain text), which Telegram users reach with /digest, /saved and /pair CODE; the RSS feeds of BBC World, The Guardian World, Al Jazeera and The Verge, read every 30 minutes; the 0G Compute router with glm-5.3-flash for the digest and translation into 10 languages via /lang; and Deepgram nova-2 speech to text, called only by the voice poller. Planned hardening, not built yet: pair the glasses (device id, /api/pair/start code, ?device=), a shared secret for the voice relay, atomic state writes with state.json.bak, and a paired device for /api/save plus a rate limit on /api/refresh." src="docs/architecture-light.png">
</picture>

The diagram shows what runs today; the four amber cards are planned and
not built yet. It is rendered from HTML by
[`docs/diagram/render.mjs`](docs/diagram/render.mjs) (Playwright, Inter,
Lucide icons), which checks the layout and text contrast before it writes
the PNGs. To regenerate it:

```bash
cd docs/diagram && npm install && npx playwright install chromium && npm run render
```

The diagram's dependencies live only in `docs/diagram/`; the backend
stays dependency-free.

## Telegram commands

| Command | What it does |
| --- | --- |
| `/start` | Link this chat |
| `/digest` | Show your latest digest |
| `/saved` | List the stories this chat saved from the glasses, newest first (last 10) |
| `/refresh` | Fetch a fresh digest now and send it (once every 5 minutes per chat on Free) |
| `/pro` | Show the Free and Pro plans |
| `/alerts on\|off` | Toggle breaking-news alerts |
| `/topics` | Set priority categories (or `all`) |
| `/lang en\|id` | Set digest language |
| `/place world\|Indonesia` | Set geographic priority |
| `/pair CODE` | Link your glasses in a private chat |
| `/sources` | List news feeds |
| `/help` | List all commands |

Every bot message is sent as plain text (no `parse_mode`), because the
AI-written digest can contain stray Markdown characters.

## Plans

| | Free | Pro — $3/month |
| --- | --- | --- |
| Digest | 8-story digest every 30 min | Same, plus `/refresh` anytime (no cooldown) |
| Breaking alerts | Yes | Yes |
| Saved stories | Yes | Unlimited |
| Topics | Yes | Unlimited |
| Paired glasses | 1 | Up to 3 devices |
| Languages | English + Indonesian | English + Indonesian |
| New features | — | Early access |

Payment is not wired up yet (coming soon). `/pro` shows these plans in
Telegram.

## Feedback

Early feedback from the Even Realities organizers (TVM Ventures) raised four questions: personalization (topics, places, languages), breaking-news delivery, publisher terms for summaries, and monetization. The current release covers all four — personalization (/topics, /lang, /place), breaking alerts (/alerts), publisher terms (Sources & licensing), and freemium tiers (/pro).

## Sources & licensing

Heads Up News uses the public RSS feeds from [BBC World](https://feeds.bbci.co.uk/news/world/rss.xml),
[The Guardian World](https://www.theguardian.com/world/rss),
[Al Jazeera](https://www.aljazeera.com/xml/rss/all.xml), and
[The Verge](https://www.theverge.com/rss/index.xml). Use `/sources` in
Telegram to see the active feeds.

We use only the RSS title and description as story text, plus the source,
link and publication date for attribution. Summaries are short rewrites
based on that feed text. Each story names its publisher and links to the
original article. We do not fetch or reproduce full article bodies or
bypass paywalls. Publishers retain their rights; a public RSS feed does
not imply a license to republish its content. We honor publisher
takedown requests: contact SIERA Labs through the
[repository issue tracker](https://github.com/0xcuy/sieralabs-headsup-news/issues)
with the story URL or feed so we can remove it.

## Repo layout

```
backend/server.mjs   Node 22, zero dependencies. RSS ingest -> GLM digest
                     -> JSON API + Telegram bot (long polling).
                     Also hosts the async voice-job queue (no STT here).
g2-app/              Even Hub app (Vite + TypeScript + @evenrealities/even_hub_sdk).
                     2 text containers (header, story) + 1 action list.
                     Also renders a DOM mirror for plain-browser preview.
voice-poller/        Deepgram STT poller (Python, stdlib only). Runs on the
                     32GB droplet with a file-based Deepgram key; polls the
                     backend for voice jobs and posts transcripts back.
```

## Setup

### Backend (any Linux server with Node ≥ 22)

```bash
# 1. Create the bot with @BotFather, save its token:
echo '<TELEGRAM_BOT_TOKEN>' > /root/headsup/telegram-bot-token
chmod 600 /root/headsup/telegram-bot-token
# 2. 0G router API key (for the GLM digest model):
echo '<0G_ROUTER_API_KEY>' > /root/.config/0g-router/api-key
chmod 600 /root/.config/0g-router/api-key
# 3. Run:
node backend/server.mjs          # listens on :8787
```

Endpoints: `GET /health`, `GET /api/digest`, `POST /api/save {storyId, device?}`,
`POST /api/refresh`, plus the voice queue: `POST /api/voice` (audio clip →
`202 {jobId}`), `GET /api/voice/:jobId` (poll for the transcript + command),
`GET /api/voice-jobs` and `POST /api/voice-result` (voice poller only).
The digest refreshes automatically every 30 minutes.

Then open Telegram, find your bot, and press **/start** — that links your
chat. Breaking alerts are on by default for linked chats; use
`/alerts off` to opt out or `/alerts on` to opt back in. A story from
the last two hours qualifies if two distinct feeds have strongly matching
headlines or if its headline is explicitly labeled Breaking or Urgent.
The lead goes first in the digest, with at least one hour between alerts
and no repeat alerts for matching stories for 48 hours.

Use `/topics TECH, SCIENCE` (or `/topics all` to reset), `/place Indonesia`
(or `/place world`), and `/lang en` or `/lang id`. The digest keeps the
breaking lead first and prioritizes matching places and categories when
the feeds carry them. Indonesian text is translated from the same digest;
if translation fails, the API flags the English fallback.

#### Glasses pairing API

1. Generate and store a random UUID v4 as the private device ID. Send
   `POST /api/pair/start` with JSON `{"device":"<uuid>"}` and display the
   returned `code` (a four-character string, which may start with zero).
   The response contains `expiresAt` in Unix milliseconds. Codes are
   single-use and expire after 10 minutes.
2. The user sends `/pair <code>` in a private chat with `@HeadsUpNewsBot`.
3. Use `GET /api/digest?device=<uuid>` to get that chat's digest. Unpaired
   devices and requests without a device receive the global digest. For a
   paired device the response adds `lang` and, on fallback,
   `translationUnavailable: true`.
4. Include the same `device` in the `POST /api/save` JSON object to deliver
   to only the paired chat. An unpaired device supplied to save is rejected;
   omitting the device keeps the legacy broadcast to linked chats.

Use HTTPS and keep the device UUID private. Do not expose or include it in
telemetry. A paired UUID cannot be reassigned; generate a new UUID to pair
again.

### Voice relay (Deepgram STT) — the poller runs on the 32GB droplet

The live poller runs on the droplet as
`/usr/bin/python3 /root/headsup/voice-poller/deepgram_poller.py` and reads
the Deepgram API key from `/root/.config/deepgram/api-key` (mode 600). The
backend never calls Deepgram itself; voice is an async job queue:

- The G2 app POSTs the mic clip (16 kHz 16-bit mono PCM in a WAV) to
  `POST /api/voice` and polls `GET /api/voice/:jobId`.
- `voice-poller/deepgram_poller.py` (stdlib-only Python) polls the backend
  directly on `:8787` for jobs (not through `headsup.sieralabs.com`, whose
  Cloudflare bot protection returns 403 to bare urllib requests),
  transcribes each clip with Deepgram `nova-2` (~$0.0003 per 4 s clip), and
  POSTs the transcript back.
- If the poller hasn't checked in for 20 s, `POST /api/voice` fails fast
  with `503 voice_unavailable` and the glasses say voice is offline —
  ring + tap are unaffected.

### G2 app (Even Hub simulator or real G2 glasses)

```bash
cd g2-app
npm install
npm run dev                      # vite on :5173
npm run simulate                 # Even Hub simulator -> http://localhost:5173
```

On real glasses: `npx evenhub qr --url http://<your-ip>:5173` and scan it
with the Even Hub companion app. `npm run pack` produces the `.ehpk`.

The app fetches its digest from the backend URL in `src/main.ts`
(`API_BASE` — point it at your backend host).

## Judging criteria, mapped (official DoraHacks weights)

- **Usefulness on G2 (25%)** — one glanceable story; nothing else competes
  for the display.
- **Read and write (20%)** — read on glasses, write back to Telegram with
  one tap (save); the bot also answers `/digest`.
- **Technical execution (20%)** — live RSS + LLM pipeline with fallback,
  systemd services, verified end-to-end in the free simulator.
- **UX for display and voice (15%)** — 3 lines per story, ring + tap, plus
  voice commands ("next" / "save this" / "repeat") via Deepgram STT.
- **Business potential and safety (20%)** — read-only news, no funds.
  Personalization stores the Telegram chat ID, digest preferences, and
  any paired device UUID.

## AI usage disclosure

- The digest text is generated by GLM (`glm-5.3-flash` via the 0G router)
  from RSS headlines + descriptions; sources and URLs are preserved.
- Voice commands are transcribed by Deepgram (`nova-2`) from the user's
  own short mic clips; only the recognized command word is kept, the audio
  is discarded after transcription.
- The G2 app and backend code were written with AI coding assistance
  (Muse) during the hackathon build week; the starter template is the
  official Even Hub minimal template (`@evenrealities/evenhub-cli`).
- A debug event beacon (`POST /api/event`) was used during simulator testing
  and removed before submission.

## Prior work (before Nov 23, 2026)

- The G2 app starts from the official Even Hub minimal template
  (`@evenrealities/evenhub-cli`); everything else — backend, digest
  pipeline, Telegram bot code, voice relay, UI — was built during the
  hackathon build week (Nov 23–29).
- The `@HeadsUpNewsBot` bot account was registered Nov 22; all bot code was
  written during the build week. The `sieralabs.com` domain and the
  VPS/droplet the project runs on predate the hackathon; no other SIERA Labs
  code is part of this project.

## Known limitations (Day 2)

- Saving needs the user to `/start` the bot once (Telegram rule: bots
  can't message a chat that never talked to them). — Done: the user has
  pressed `/start`; saves now deliver.
- The backend is served over TLS at `https://headsup.sieralabs.com`
  (Cloudflare → Traefik on the SIERA VPS → droplet over Tailscale).
- Voice (Deepgram STT) is live since Nov 23: a recorded 1-second clip was
  transcribed end to end, with no auth error. One honest limit:
  - Live-mic transcription on real G2 hardware is NOT tested yet — the
    simulator has no mic, so it can only prove the wiring up to
    "Mic unavailable". The glasses-mic path (PCM → WAV → queue → Deepgram)
    is tested with recorded audio through the same endpoint instead.
