<div align="center">

# Vobiz Calling for HubSpot

**Call your contacts from HubSpot, talk in the browser, and have every call logged on the contact's timeline.**

[![License: MIT](https://img.shields.io/badge/License-MIT-e83c00.svg)](LICENSE)
[![Node 20.12+](https://img.shields.io/badge/Node-20.12%2B-339933.svg)](https://nodejs.org)

[Setup guide](docs/SETUP_GUIDE.md) · [Architecture](docs/ARCHITECTURE.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Docs](https://www.vobiz.ai/docs/integrations/hubspot)

</div>

---

Vobiz Calling for HubSpot adds a Vobiz softphone to HubSpot's calling panel. You run a small
Node.js backend, register it with HubSpot as a calling provider, and your agents sign in with
their Vobiz account. They place and take calls in the browser over WebRTC, and HubSpot logs each
call on the contact's timeline.

## Features

- **Click-to-call.** Click any phone number in HubSpot, or type one into the panel, and the call starts.
- **Inbound calls with a screen pop.** A call to your Vobiz number rings every signed-in agent with an
  **Answer** / **Decline** overlay. The first agent to answer takes it.
- **Call logging.** HubSpot creates a call engagement on the contact's timeline for every call, inbound
  and outbound.
- **Recordings.** Every call is recorded by Vobiz. Agents play recent recordings in the panel.
- **Caller ID choice.** Agents pick which of your Vobiz numbers their calls go out from.
- **Multi-agent.** Each HubSpot user gets their own Vobiz SIP endpoint, created automatically on first sign-in.
- **Two sign-in modes.** Sign in with your Vobiz account (Auth ID + Auth Token), or with one existing
  SIP endpoint's username and password (SIP direct).
- **Any Vobiz account.** One backend serves any number of Vobiz accounts. Nothing account-specific is
  configured on the server.

## How it works

```
 HubSpot (calling panel)                 Your backend                        Vobiz
 ───────────────────────                 ────────────                        ─────
 widget  ── sign in (HTTPS) ──────────▶  /login  ── REST API ─────────────▶  application, endpoints, numbers
 widget  ── SIP over WebSocket ──────────────────────────────────────────▶  registrar
 widget  ── call (SIP INVITE) ───────────────────────────────────────────▶  Vobiz ── answer URL ─▶ /answer
                                         /answer ── <Dial><Number> ──────▶  rings the customer
 caller  ──────────────────────────────────────────────────────────────▶  your number ─▶ /answer
                                         /answer ── <Dial><User> ────────▶  rings the agents' browsers
 widget  ── call started / ended ─▶ HubSpot logs the call on the contact
```

- The **widget** is a web page HubSpot loads in its calling panel. Your backend serves it at `/widget/`.
- An agent signs in from the widget. The backend checks the credentials with Vobiz and sets up what the
  account needs (an application and one SIP endpoint per agent).
- The browser registers to Vobiz as that agent's SIP endpoint and makes outbound calls itself.
- Vobiz asks your backend's **answer URL** (`/answer`) what to do with each call. For outbound calls the
  backend dials the customer; for inbound calls it rings the browsers of the signed-in agents.
- Every call is recorded. Vobiz notifies the backend when the recording is ready.
- The widget tells HubSpot when a call starts and ends, and HubSpot writes the call to the contact's
  timeline using the agent's own HubSpot session.

## Requirements

| You need | Details |
| --- | --- |
| A Vobiz account | Your **Auth ID** and **Auth Token** from the [Vobiz Console](https://console.vobiz.ai) → **API credentials**, at least one active voice-enabled number, and call balance. |
| A HubSpot account | Admin rights to install apps, and **Developer tools access** (or a **Developer seat** on seat-based accounts) to create the app. |
| A public HTTPS URL | For the backend, for example `https://calling.example.com`. Vobiz calls it for every call, and HubSpot loads the widget from it. |
| Node.js | Version 20.12 or newer. |
| A browser and microphone | A current Chrome, Edge or Firefox. Agents must allow microphone access. |

## Quick start

The full walkthrough, including where each HubSpot setting lives, is in
[docs/SETUP_GUIDE.md](docs/SETUP_GUIDE.md).

1. **Clone and install.**

   ```bash
   git clone https://github.com/vobiz-ai/Vobiz-HubSpot-Calling.git
   cd Vobiz-HubSpot-Calling
   npm ci
   npm run build          # builds the widget bundle into source/
   ```

2. **Configure the backend.** The `.env` file holds deployment settings only. There are no Vobiz
   credentials in it.

   ```bash
   cp backend/.env.example backend/.env
   ```

   Set at least:

   ```ini
   PUBLIC_BASE=https://calling.example.com
   SIGNING_SECRET=<a long random string, e.g. from: openssl rand -hex 32>
   ```

   `HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET` come from the HubSpot app you create in step 5.

3. **Run it.**

   ```bash
   npm start              # listens on port 8092
   ```

4. **Expose it on your public HTTPS URL** (a reverse proxy, load balancer or tunnel to port 8092), then
   check it from outside:

   ```bash
   curl -s https://calling.example.com/health
   curl -s -X POST https://calling.example.com/answer -d "Event=Hangup"   # must print <Response></Response>
   ```

5. **Create the HubSpot app** with the HubSpot CLI (included as a dev dependency).

   ```bash
   npx hs account auth                           # authenticate the CLI once (~/.hscli/config.yml)
   npm run sync-urls                             # writes PUBLIC_BASE into src/app/app-hsmeta.json
   npx hs project upload --account=<portalId>
   npx hs project info --account=<portalId>      # shows the App ID
   ```

   Copy the app's **Client ID** and **Client secret** (Development → Projects → your app → Auth) into
   `backend/.env`, then restart the backend.

   `npm run sync-urls` edits `src/app/app-hsmeta.json` in place. Do not commit that change.

6. **Register the calling widget with HubSpot.** Add `HUBSPOT_APP_ID` and `HUBSPOT_DEVELOPER_API_KEY`
   to `backend/.env` (or export them; the shell wins), then:

   ```bash
   npm run calling:configure    # widget URL defaults to <PUBLIC_BASE>/widget/
   ```

7. **Install the app** by opening `https://calling.example.com/hubspot/install` and choosing your
   HubSpot account. You should see **Connected to HubSpot**. To test first, install into a
   **developer test account** (see [Limitations](#limitations)).

8. **Choose Vobiz as the calling provider.** In HubSpot, open a contact with a phone number, click
   **Call**, then **Change provider** and pick **Vobiz Calling**. Sign in, wait for **Ready**, and call.

## Sign in

The widget has two tabs. Pick one per agent.

### Vobiz account (recommended)

Enter your **Auth ID** (`MA_XXXXXXXX`) and **Auth Token** from Console → **API credentials**. The Auth
Token is not your Console login password.

When you sign in, the backend checks the credentials with Vobiz and sets up your account:

- **An application** named `vobiz-hubspot-calling-integration`, with its answer URL and hangup URL set
  to `<PUBLIC_BASE>/answer` (POST). If it already exists, it is reused and pointed at your backend.
  No other application in your account is changed.
- **One SIP endpoint per agent**, with the alias `hubspot-<agent>`, linked to that application. The agent
  is identified by their HubSpot user, so each HubSpot user gets their own endpoint. A fresh random SIP
  password is set on every sign-in and sent only to that agent's browser.

Signing in does not move any of your numbers.

**Choose a caller ID.** The **Calling from** dropdown lists your account's active, voice-enabled numbers.
Outbound calls show the number you pick. The backend refuses any number that is not on your account.

**Enable inbound calls.** Under **Enable inbound calls**, pick a number and click the button. This
attaches the number to the `vobiz-hubspot-calling-integration` application, so calls to it ring your
signed-in agents. A number can belong to only one application, so this **moves the number off the
application it is on now**. The dropdown shows the current application next to each number
(`now on app …`), and the confirmation names the application the number moved from, with its ID. You only need to
do this once per number.

### SIP direct

Use this for agents who should not hold your account's Auth Token. Enter an existing endpoint's
**SIP username**, its **SIP password**, and the **Calling from** number in E.164 format
(`+91XXXXXXXXXX`). The password stays in the browser and never reaches the backend.

Before you use SIP direct, point the endpoint and the number at an application whose answer URL is your
backend.

In the Vobiz Console:

1. Create an application with **Answer URL** and **Hangup URL** set to
   `https://calling.example.com/answer`, method **POST**.
2. Under **Voice → Endpoints**, set the endpoint's application to it.
3. Under **Numbers**, attach the caller-ID number to the same application.

Or with the API:

```bash
API=https://api.vobiz.ai/api/v1/Account/MA_XXXXXXXX
H=(-H "X-Auth-ID: MA_XXXXXXXX" -H "X-Auth-Token: $VOBIZ_AUTH_TOKEN" -H "Content-Type: application/json")

# 1. Create the application; note the app_id in the response
curl -X POST "$API/Application/" "${H[@]}" -d '{"app_name":"hubspot-sip-direct",
  "answer_url":"https://calling.example.com/answer","answer_method":"POST",
  "hangup_url":"https://calling.example.com/answer","hangup_method":"POST"}'

# 2. Link the endpoint to it
curl -X POST "$API/Endpoint/<endpoint_id>/" "${H[@]}" -d '{"app_id":"<app_id>"}'

# 3. Attach the number (the + is written %2B)
curl -X POST "$API/numbers/%2B91XXXXXXXXXX/application" "${H[@]}" -d '{"application_id":"<app_id>"}'
```

Use the endpoint's **stored** username exactly as Console → Voice → Endpoints shows it. Use a separate
endpoint for each integration: an endpoint belongs to one application at a time.

In SIP direct mode you do not get the number dropdown, **Enable inbound calls**, or the recordings list.
Those need the account API. Inbound calls to the caller-ID number ring a SIP direct agent.

## Using it

**Outbound.** Click a phone number anywhere in HubSpot, or type a number with its country code
(`+91XXXXXXXXXX`) into **Number to call** and click **Call**. The button is enabled once the status
badge shows **Ready**. While the call is live the panel shows a timer and **Hang up**.

**Inbound.** Keep HubSpot open and the panel signed in. A call to an enabled number raises the
**Incoming Vobiz Call** overlay for every agent signed in to that Vobiz account. Press **Answer** (or
Enter) to pick up, **Decline** (or Escape) to dismiss. If no agent is signed in, the caller hears
"Sorry, no one is available to take your call right now" and the call ends.

**Call logging.** For every call, the widget tells HubSpot the call has started and, when it ends,
that it is complete. HubSpot creates the call engagement itself and shows it on the contact's activity
timeline, where you can add notes and an outcome. The backend does not write to HubSpot.

**Recordings.** Every call, inbound and outbound, is recorded, up to one hour per call. **Call recordings** in the panel lists the account's 15 most recent recordings with their length
and time. **Play** streams the audio through a signed link that expires after 15 minutes by default.

Calls ring for up to 30 seconds and are limited to 4 hours.

## Configuration reference

The backend reads `backend/.env` (or the process environment).

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `PUBLIC_BASE` | Yes | none | Your backend's public HTTPS URL. Becomes the answer URL in each Vobiz account and the base of recording links. |
| `SIGNING_SECRET` | Yes in production | random per start | Signs recording playback links. If unset, links stop working after every restart. |
| `HUBSPOT_CLIENT_ID` | Yes | none | Your HubSpot app's Client ID. |
| `HUBSPOT_CLIENT_SECRET` | Yes | none | Your HubSpot app's Client secret. |
| `HUBSPOT_SCOPES` | No | `oauth` | Scopes requested at install. Matches the app's `requiredScopes`; extra scopes make the install ask agents for CRM permissions. |
| `HUBSPOT_REDIRECT_URI` | No | `<PUBLIC_BASE>/hubspot/callback` | OAuth redirect. Must match `redirectUrls` in `src/app/app-hsmeta.json`. |
| `PORT` | No | `8092` | Port the backend listens on. |
| `RECORDING_URL_TTL_SECONDS` | No | `900` | How long a recording playback link stays valid. |
| `SESSION_TTL_HOURS` | No | `12` | How long a widget sign-in lasts. |
| `DATA_DIR` | No | `backend/data` | Directory for the backend's state files (created mode 0700; files 0600). A relative path is taken from `backend/`. Files an older version left in `backend/` are read until the next write moves them here. |
| `AGENT_ENDPOINT_STORE` | No | `<DATA_DIR>/agent-endpoints.json` | File that maps each agent to their Vobiz endpoint. |
| `ALLOWED_ORIGINS` | No | none | Extra browser origins allowed to call the backend, comma separated. HubSpot, `localhost` and `PUBLIC_BASE` are always allowed. |
| `TUNNEL_URL` | No | none | Used as the public URL when `PUBLIC_BASE` is not set. |
| `VOBIZ_API_URL` | No | `https://api.vobiz.ai` | Vobiz REST API. Leave the default. |
| `VOBIZ_REGISTRAR` | No | `registrar.vobiz.ai` | Vobiz SIP registrar. Leave the default. |

`VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN`, `VOBIZ_FROM_NUMBER`, `VOBIZ_SIP_USER` and `VOBIZ_SIP_PASSWORD` are
ignored if set. Agents bring their own credentials when they sign in.

`npm run calling:configure` reads these from `backend/.env` and your shell; a shell variable wins:

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `HUBSPOT_APP_ID` | Yes | none | The App ID from `npx hs project info`. |
| `HUBSPOT_DEVELOPER_API_KEY` | Yes | none | Your HubSpot developer API key (Development → Keys). |
| `WIDGET_URL` | No | `<PUBLIC_BASE>/widget/` | The widget URL HubSpot loads. |
| `CALLING_APP_NAME` | No | `Vobiz Calling` | The provider name agents see in HubSpot. |
| `HUBSPOT_CALLING_API_VERSION` | No | `2026-09` | Version segment of HubSpot's calling settings API. |

Flags: `--no-inbound` turns inbound calling off in HubSpot, `--no-calling-window` keeps calls in the
in-page panel instead of HubSpot's separate calling window, `--not-ready` hides the provider from
agents. `npm run calling:show` prints the current settings.

## Deploying to production

- **Use a stable HTTPS hostname.** Vobiz, HubSpot's app manifest and the widget URL all point at it.
  If it changes, update `PUBLIC_BASE`, run `npm run sync-urls` and `npx hs project upload`, run
  `npm run calling:configure` with the new widget URL, and have each account sign in again so its
  application is re-pointed.
- **Run exactly one backend instance.** Sign-ins, calls and the Vobiz Auth Tokens are held in memory.
  A second instance would not know about agents signed in to the first.
- **Keep `DATA_DIR` on persistent storage** (default `backend/data`). `agent-endpoints.json` (or
  `AGENT_ENDPOINT_STORE`) and `hubspot-tokens.json` are written there. If they are lost, agents'
  endpoints are found again by alias and you reinstall the app from `/hubspot/install`.
- **Set `SIGNING_SECRET`** to a fixed random value so recording links survive restarts.
- **Upload the app manifest with your real hostname** (`npm run sync-urls`, then `npx hs project upload`).
  The app's `distribution` is `private`.

## Security and privacy

- **Your Auth Token never leaves the server and is never stored on disk.** It is sent once at sign-in,
  kept in the backend's memory, and never logged or returned to the browser. The widget can remember
  your Auth ID if you tick **Remember my Auth ID**; it never stores the Auth Token.
- **The browser gets a session token**, kept for that tab only, plus its own endpoint's SIP username and
  password. An agent can only read their own SIP credentials.
- **SIP direct passwords never reach the backend.** The backend stores only which caller ID belongs to
  which SIP username.
- **On disk**, in `DATA_DIR` (mode 0700), the backend keeps `agent-endpoints.json` (agent → endpoint ID and SIP username, no
  passwords) and `hubspot-tokens.json` (the HubSpot OAuth tokens), both readable only by the backend's
  user (mode 0600).
- **Recording links carry no credentials.** Each link is signed for one recording in one account and
  expires (15 minutes by default). The backend fetches the audio itself, only from an allowlist of Vobiz
  and cloud storage hosts, and sends your credentials only to Vobiz.
- **The backend only answers browsers from HubSpot**, `localhost`, its own origin and any origins you add
  in `ALLOWED_ORIGINS`.
- **Calls are kept per account.** An inbound call rings only agents of the Vobiz account that owns the
  number, and an agent can only use their own account's numbers as caller ID.
- **Vobiz webhooks are not signature-checked.** Keep `/answer`, `/dial-status` and `/recording-ready`
  reachable only over HTTPS.
- Anyone who signs in with the Auth ID and Auth Token holds your account's API credentials. Give agents
  SIP direct if they should not. See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| HubSpot says **Calling is offline** | The widget did not load: the bundle was not built, or the backend is unreachable. | Run `npm run build`, restart, and check `https://calling.example.com/widget/` opens in a browser. |
| The panel is blank | Your host is not in the app's `permittedUrls`. | `npm run sync-urls`, then `npx hs project upload`. |
| **Vobiz Calling** is not in the provider list | The app is not installed in this portal, the calling widget is not registered, or it was registered with `--not-ready`. | Run `npm run calling:show`; re-run `npm run calling:configure`; install from `/hubspot/install` into this portal. |
| "Your account doesn't have access to developer tools" | Your HubSpot user lacks developer access. | Grant **Developer tools access**, or assign a **Developer seat**. |
| "There was a problem fetching approvers" | You are installing into a portal where you are the only user, so there is nobody to approve. | Install into a developer test account. |
| Install asks for contacts and custom-object permissions | `HUBSPOT_SCOPES` is set to more than `oauth`. | Remove it (or set `HUBSPOT_SCOPES=oauth`), restart, and install again. |
| "Authorisation rejected" after install | The install was not started from `/hubspot/install`, took over 10 minutes, or the backend restarted mid-install. | Open `/hubspot/install` again. |
| "Vobiz did not accept that Auth ID and Auth Token" | Wrong credentials, or the Console login password was used. | Copy both again from Console → **API credentials**. |
| Status never reaches **Ready**; "Registration failed" | The browser could not register the SIP endpoint. In SIP direct, usually the wrong username. | Account mode: sign in again. SIP direct: use the stored username from Console → Voice → Endpoints. |
| The customer's phone never rings, or they hear "the agent could not be reached" | Vobiz cannot reach your answer URL, or the application points at an old hostname. | `curl -X POST <PUBLIC_BASE>/answer -d "Event=Hangup"` must return XML. Sign in again to re-point the application. |
| Outbound call ends at once | The agent has no valid caller ID, or the number is not active and voice-enabled. | Choose a number in **Calling from**; check the number in Console. |
| Inbound callers hear "no one is available" | No agent of that account is signed in (for example, after a backend restart). | Sign in to the panel. |
| Inbound calls do not reach the panel at all | The number is not attached to the integration's application. | Click **Enable inbound calls** for that number. |
| The browser rings but HubSpot shows nothing | Inbound calling is off in HubSpot's calling settings. | Re-run `npm run calling:configure` without `--no-inbound`. |
| A recording says "Sign in to the calling panel again" or "invalid or has expired" | The backend restarted, or the link is older than its expiry. | Sign in again, then refresh the recordings list. |
| An agent's other browser tab stops receiving calls | Each sign-in sets a new SIP password for that agent. | Use one browser tab per agent. |

More detail in [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Limitations

- **Sign in again after the backend restarts.** Sessions and Auth Tokens live in memory. Until an agent
  of an account signs in again, that account's inbound calls get the "no one is available" message and
  its recording links ask you to sign in.
- **Run one backend instance.** State is not shared between instances.
- **One browser per agent.** Signing in from a second browser sets a new SIP password, which disconnects
  the first.
- **Inbound calls ring every signed-in agent of the account.** There is no queue, skills routing or
  per-number assignment.
- **Every call is recorded**, up to one hour per call. There is no setting to turn it off.
- **Recordings are in the panel only.** The list shows the account's 15 most recent recordings; they are
  not attached to the HubSpot call record.
- **SIP direct** has no number list, no **Enable inbound calls** and no recordings, and the password must
  be typed again after a page reload. You set up the application, endpoint and number yourself.
- **Install needs a user with CRM permissions.** In a portal where you are the only user, install
  into a developer test account instead.
- **Private app.** The app is installed with `private` distribution; it is not listed on the HubSpot
  App Marketplace.

## Development

```bash
npm ci
npm run build       # widget bundle (webpack) -> source/demo-minimal-js.bundle.js
npm test            # backend tests, against a local stand-in for the Vobiz API
npm run audit       # scans the repository for committed credentials
npm start           # backend on :8092
```

For a temporary public URL during development, `cd backend && npm run tunnel` starts a Cloudflare quick
tunnel and the backend picks its URL up when `PUBLIC_BASE` is not set. Quick-tunnel hostnames change on
every restart, so use them for testing only.

```
backend/server.js            webhooks, sign-in, Vobiz API calls, recordings, widget hosting
backend/hubspot-oauth.js     HubSpot OAuth install and token storage
backend/test/                backend tests
source/                      the widget: index.html, index.js (JsSIP + HubSpot Calling Extensions SDK), styles
src/app/app-hsmeta.json      HubSpot app manifest (hostname placeholder; filled by npm run sync-urls)
hsproject.json               HubSpot developer project
scripts/                     configure-calling, sync-app-urls, create-test-account, check-credentials
docs/                        setup guide, architecture, troubleshooting
```

`npm run test-account "<name>"` creates a HubSpot developer test account. It reads the default
account's personal access key from `~/.hscli/config.yml` (written by `npx hs account auth`), or from
a `hubspot.config.yml` an older CLI wrote in the repository root. Both hold a credential; both are
git-ignored.

## Support

- Vobiz documentation: https://www.vobiz.ai/docs
- This integration: https://www.vobiz.ai/docs/integrations/hubspot
- Issues: https://github.com/vobiz-ai/Vobiz-HubSpot-Calling/issues
- Email: support@vobiz.ai

## License

[MIT](LICENSE)
