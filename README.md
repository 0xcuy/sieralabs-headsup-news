![Heads Up News — Telegram AI news digest for Even Realities G2 glasses](banner.jpg)

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
  <img alt="Heads Up News architecture. Users: a Telegram user in their own chat with the bot, and a G2 glasses wearer using ring + tap, voice and save to Telegram. Run by SIERA: the G2 app (g2-app/src/main.ts, on the glasses, Even Hub SDK) calls headsup.sieralabs.com over HTTPS for /api/digest, /api/save, /api/voice and /api/pair, through Cloudflare (proxied DNS) to Traefik; Traefik on the SIERA VPS terminates TLS and routes over Tailscale to port 8787 on the 32GB droplet; the Telegram bot backend (backend/server.mjs, Node 22 or later, zero npm dependencies, state in state.json) runs there; the voice poller (voice-poller/deepgram_poller.py) also runs on the 32GB droplet, reads the Deepgram key from a mode-600 file, polls the backend directly on port 8787 for voice jobs and posts transcripts back. Third-party services: the Telegram Bot API (getUpdates long polling, sendMessage as plain text), which Telegram users reach with /digest, /saved and /pair CODE; the RSS feeds of BBC World, The Guardian World, Al Jazeera and The Verge, read every 30 minutes; the 0G Compute router with glm-5.3-flash for the digest and translation into 10 languages via /lang; and Deepgram nova-2 speech to text, called only by the voice poller. Hardening: pairing the glasses is built (a UUID v4 device id kept in Even Hub storage, the /pair code shown on the glasses, ?device= on digest and save), plus Stars payments for the Pro subscription (150 Stars / 30 days; atomic state.json writes with a state.json.bak backup). Planned, not built yet: a shared secret for the voice relay, and a rate limit on /api/refresh." src="docs/architecture-light.png">
</picture>

The diagram shows what runs today; in the bottom band the green "Built"
card (glasses pairing) is live code and the three amber cards are planned
and not built yet. It is rendered from HTML by
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
| `/refresh` | Fetch a fresh digest now and send it (every 30 minutes on Free, every 5 minutes on Pro) |
| `/pro` | Show the Free and Pro plans with an "Upgrade: 150 ⭐/month" button |
| `/cancelpro` | Stop Pro auto-renewal; Pro stays on until the paid period ends |
| `/terms` | Pro subscription terms (price, auto-renewal, cancellation, refunds) |
| `/paysupport` | How to get payment support and refunds |
| `/alerts on\|off` | Toggle breaking-news alerts |
| `/topics` | Set priority categories (or `all`); max 3 on Free, unlimited on Pro |
| `/lang CODE` | Set digest language: `en`, `id`, `ru`, `zh`, `es`, `fr`, `de`, `ja`, `ar` or `pt` (see [Languages](#languages)) |
| `/place world\|Indonesia` | Set geographic priority |
| `/pair CODE` | Link your glasses in a private chat (1 pair on Free, up to 3 on Pro) |
| `/unpair` | Unlink this chat's glasses; they show a new pairing code |
| `/refund` | Owner only: refund a Pro payment and revoke Pro |
| `/sources` | List news feeds |
| `/help` | List all commands |

Every bot message is sent as plain text (no `parse_mode`), because the
AI-written digest can contain stray Markdown characters. The `/pro` upgrade
control is an inline URL button that opens a Telegram payment sheet — Stars
payments run entirely inside Telegram, with no external payment provider.

## Languages

`/lang CODE` sets the digest language for a chat. The digest is written in
English and translated by GLM on the 0G router; the header and the
"Updated" date follow the language too.

| Code | Language | Digest header | Date locale |
| --- | --- | --- | --- |
| `en` | English | News Digest | en-GB |
| `id` | Indonesian | Ringkasan Berita | id-ID |
| `ru` | Russian | Новостной дайджест | ru-RU |
| `zh` | Chinese (Simplified) | 新闻摘要 | zh-CN |
| `es` | Spanish | Resumen de noticias | es-ES |
| `fr` | French | Résumé de l’actualité | fr-FR |
| `de` | German | Nachrichtenüberblick | de-DE |
| `ja` | Japanese | ニュースダイジェスト | ja-JP |
| `ar` | Arabic | موجز الأخبار | ar-EG |
| `pt` | Portuguese | Resumo de notícias | pt-BR |

Any other code gets a reply listing these ten. Bot replies other than the
digest itself stay in English.

## Plans

Paid via **Telegram Stars** — the only way to sell digital goods inside a
Telegram bot (app-store rules and Telegram terms; no Stripe or any other
payment provider, no crypto). 150 Stars every 30 days (buyer pays ~$2.99,
owner receives ~$1.95 after Telegram's cut), set up as a Telegram bot
subscription with auto-renewal. No provider signup, no KYC, and no new keys:
it uses the existing bot token.

| | Free | Pro — 150 Stars / 30 days |
| --- | --- | --- |
| Digest | 8-story digest every 30 min | Same, plus `/refresh` every 5 min (Free: every 30 min) |
| Breaking alerts | Yes | Yes |
| Saved stories | 20 | Unlimited |
| Topics | 3 priority topics | Unlimited |
| Paired glasses | 1 device | Up to 3 devices |
| Languages | 10 digest languages | 10 digest languages |
| New features | — | Early access |

`/pro` sends the plan overview with an "Upgrade: 150 ⭐/month" button that
opens a Stars subscription checkout generated by `createInvoiceLink` (30
days is the only subscription period Telegram allows). The bot answers the
pre-checkout query within Telegram's 10-second limit and stores the Pro
expiry (`proUntil`, plus the Telegram charge id) in `state.json` on the
successful-payment confirmation. Telegram re-charges every 30 days and each
renewal pushes `proUntil` forward; if the user cancels or a charge fails, Pro
simply turns off at the expiry date — no scheduled job needed.

- `/cancelpro` stops the auto-renewal (`editUserStarSubscription`);
  Pro stays on until the paid period ends.
- `/terms` and `/paysupport` are the payment texts Telegram requires before
  a payments bot goes live.
- `/refund <chat id>` is owner-only (`ADMIN_CHAT_ID` env) and refunds the
  last charge via `refundStarPayment`, revoking Pro immediately.

### Testing the Stars flow without spending money

Telegram maintains a separate test environment where Stars payments are free.
Run the backend against it:

1. Build/run a local Bot API server (`telegram-bot-api`) with `--test-dc`,
   which connects to Telegram's test data center.
2. In the test environment (web.telegram.org/?test=1 or a test-build client),
   create a throwaway account and a test bot with @BotFather; save its token
   to a file (for example `/root/headsup/test-bot-token`), never in the repo.
3. Start the backend pointed at the local server and the test token:

   ```bash
   TELEGRAM_API=http://127.0.0.1:8081 \
   BOT_TOKEN_FILE=/root/headsup/test-bot-token \
   ADMIN_CHAT_ID=<your telegram id> \
   STATE_DIR=/root/headsup-test \
   node backend/server.mjs
   ```

4. Message the test bot, press `/pro`, tap the upgrade button, and pay with
   test Stars. `/terms` and `/paysupport` must be set for the bot before
   switching to production (Telegram's live checklist).

The unit tests (`node --test`) cover the same flow end to end with a mocked
Bot API and no token present.

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
ADMIN_CHAT_ID=<your Telegram user id> node backend/server.mjs   # listens on :8787
```

`ADMIN_CHAT_ID` (optional) enables the owner-only `/refund` command.

Endpoints: `GET /health`, `GET /api/digest?device=`, `POST /api/save {storyId, device?}`,
`POST /api/pair/start {device}`, `GET /api/pair/status?device=`,
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
(or `/place world`), and `/lang ru` (any code from [Languages](#languages)). The digest keeps the
breaking lead first and prioritizes matching places and categories when
the feeds carry them. Non-English digests are translated from the same
digest by GLM, cached per language; if translation fails, the chat gets
the English digest with a note and the API flags the fallback.

#### Glasses pairing API

1. Generate and store a random UUID v4 as the private device ID. Send
   `POST /api/pair/start` with JSON `{"device":"<uuid>"}` and display the
   returned `code` (a six-digit string, which may start with zero).
   The response contains `expiresAt` in Unix milliseconds. Codes are
   single-use and expire after 10 minutes.
2. The user sends `/pair <code>` in a private chat with `@HeadsUpNewsBot`.
3. Poll `GET /api/pair/status?device=<uuid>` (returns `{ok, paired}`) until
   `paired` is `true`; request a new code when the old one expires.
4. Use `GET /api/digest?device=<uuid>` to get that chat's digest. Unpaired
   devices and requests without a device receive the global digest. With a
   valid `device` the response adds `paired`; for a paired device it also
   adds `lang` and, on fallback, `translationUnavailable: true` with
   `requestedLang`.
5. Include the same `device` in the `POST /api/save` JSON object to deliver
   to only the paired chat. An unpaired device supplied to save gets
   `409 device_not_paired` and nothing is sent; omitting the device keeps
   the legacy broadcast to linked chats (the G2 app always sends it).
6. `/unpair` in the chat removes its glasses; the same UUID can then pair
   again with a fresh code.

`g2-app/src/main.ts` implements this flow: it keeps the UUID under
`headsup.device` in Even Hub local storage (browser `localStorage` in the
DOM preview), shows `PAIR GLASSES · send /pair CODE to @HeadsUpNewsBot` in
the header while the global digest keeps scrolling, polls every 5 s, and
flashes `PAIRED` when the chat claims the code.

Use HTTPS and keep the device UUID private. Do not expose or include it in
telemetry. A paired UUID cannot be claimed by another chat until it is
unpaired.

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

Download the built app: https://blog.sieralabs.com/headsup-g2-pairing.ehpk
(install via Even Hub).

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
