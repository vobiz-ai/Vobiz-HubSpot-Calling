<div align="center">

# Vobiz Calling for HubSpot

**A softphone inside HubSpot. Agents call from a contact record, talk in the browser, and HubSpot logs the call against that contact automatically.**

[![License: MIT](https://img.shields.io/badge/License-MIT-e83c00.svg)](LICENSE)
[![Node 20.12+](https://img.shields.io/badge/Node-20.12%2B-339933.svg)](https://nodejs.org)

[Setup](docs/SETUP_GUIDE.md) · [Architecture](docs/ARCHITECTURE.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Docs](https://www.vobiz.ai/docs/integrations/hubspot)

</div>

---

## What it does

| | |
| --- | --- |
| **Call from a record** | Dial from a HubSpot contact and the call is logged against it. |
| **Automatic engagement** | HubSpot creates the call engagement from the widget's SDK messages. |
| **Inbound screen pop** | An incoming call raises an Answer / Decline overlay in the tab. |
| **Recordings** | Playable from the widget behind an expiring signed link that carries no credentials. |
| **Browser audio** | Calls run over WebRTC in the tab. No desk phone, no desktop app. |
| **No CRM scopes** | The backend never writes to HubSpot, so the app asks for none. |

## The one thing to understand first

**The browser is the A leg.** The widget sends the SIP INVITE itself; the
backend answers `<Dial><Number>` to reach the customer.

```
widget ──SIP INVITE──▶ Vobiz ──answer_url──▶ backend /answer
                                                 │
                                          <Dial><Number> ──▶ customer
```

The intuitive design — the backend dials the customer over the REST API, then
bridges the agent in with `<Dial><User>` — **cannot work**. Routing *into* a
registered WebRTC endpoint is blocked platform-side: Vobiz builds a gateway URI
it cannot itself parse and drops its own INVITE. The customer answers, hears
ringback, then "the agent could not be reached".

Inbound is the exception: `<Dial><User>` is the only way to reach a registered
endpoint, and it works.

## What talks to what

| Piece | Role |
| --- | --- |
| `source/` | The widget HubSpot iframes. SIP stack, dialpad, and the Calling Extensions SDK calls that make HubSpot log the call |
| `backend/server.js` | Answers Vobiz webhooks, serves the widget, holds credentials, brokers the Vobiz REST API |
| `backend/hubspot-oauth.js` | HubSpot OAuth — install, callback, refresh |
| `scripts/configure-calling.js` | Registers the widget with HubSpot and enables inbound |

HubSpot creates the call engagement itself, from the SDK messages the widget
sends (`cti.outgoingCall`, `cti.incomingCall`, `cti.callCompleted`), using the
**agent's own session**. The backend never writes to the CRM, which is why the
app needs no CRM scopes.

## Quick start

Requires **Node 20.12+** (the backend reads `.env` with `process.loadEnvFile`), a [Vobiz](https://console.vobiz.ai) account with a number
and balance, a HubSpot account with developer tools, and `cloudflared` (or
ngrok) for a public HTTPS URL.

The one-time setup is in [`docs/SETUP_GUIDE.md`](docs/SETUP_GUIDE.md). Per
session:

```bash
npm install
npx webpack                                     # build the widget bundle
npm start                                       # backend on :8092
cloudflared tunnel --url http://localhost:8092  # public HTTPS
```

Put the tunnel URL in `PUBLIC_BASE`, restart, then **verify before touching the
UI**:

```bash
curl -s "$PUBLIC_BASE/health"
curl -s "$PUBLIC_BASE/hubspot/status"                              # "connected": true
curl -sL -o /dev/null -w '%{http_code}\n' "$PUBLIC_BASE/widget"    # 200
curl -s -X POST "$PUBLIC_BASE/answer" \
  -d "From=sip:x@registrar.vobiz.ai&To=91XXXXXXXXXX&RouteType=sip"
```

The last one must return `<Response>` containing `<Dial …><Number>`. Anything
else — a tunnel error page, an ngrok interstitial — and every call dies
silently.

**If the tunnel hostname changed**, four things go stale together: `PUBLIC_BASE`,
the Vobiz `answer_url`, `permittedUrls.iframe`, and the HubSpot widget URL.

## Configuration

Copy `backend/.env.example` to `backend/.env`. Everything is set there.

| Variable | Description |
| --- | --- |
| `VOBIZ_AUTH_ID` / `VOBIZ_AUTH_TOKEN` | From the Vobiz console, under API credentials |
| `VOBIZ_FROM_NUMBER` | A DID this account owns, used as the outbound caller ID |
| `VOBIZ_SIP_USER` / `VOBIZ_SIP_PASSWORD` | **Leave empty** for teams: each agent gets their own endpoint on first sign-in. Set both only for a single-agent install that should register as one existing endpoint |
| `PUBLIC_BASE` | The public HTTPS URL Vobiz can reach |
| `HUBSPOT_CLIENT_ID` / `HUBSPOT_CLIENT_SECRET` | From your HubSpot app |
| `SIGNING_SECRET` | Signs recording links. Set it explicitly — a random key each boot invalidates older links |
| `RECORDING_URL_TTL_SECONDS` | How long a recording link stays valid |
| `ALLOWED_ORIGINS` | Extra CORS origins. HubSpot, localhost and `PUBLIC_BASE` are allowed by default |
| `AGENT_ENDPOINT_STORE` | Where the agent → endpoint-id map is kept (default `backend/agent-endpoints.json`, mode 0600, git-ignored, holds no passwords) |
| `SESSION_TTL_HOURS` | How long a widget sign-in lasts (default 12) |

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET/POST | `/answer`, `/inbound-answer` | The XML Vobiz executes. Branches on direction |
| POST | `/dial-status` | The `action` target of `<Dial>` — how the call ended |
| POST | `/recording-ready` | Fires when the recording is downloadable |
| POST | `/start-call` | The widget's click-to-dial entry point |
| POST | `/login`, `/login-sip`, `/logout` | Sign-in. `/login` checks the Auth ID / Auth Token against Vobiz and returns a session token; every other widget route needs `Authorization: Bearer <token>` |
| GET | `/agent` | This agent's own SIP identity (session token required) |
| POST | `/select-number` | Sets the outbound caller ID |
| POST | `/setup-inbound` | Creates the application, binds the endpoint, attaches the DID |
| GET | `/hubspot/install`, `/hubspot/callback`, `/hubspot/status` | HubSpot OAuth |
| GET | `/widget` | Serves the widget bundle |
| GET | `/health` | Resolved configuration |

## Notes

Behaviours worth knowing before changing anything:

- **`<Record>` is a self-closing sibling *before* `<Dial>`,** never nested
  inside it. The nested form is rejected and the caller hears a bogus "Busy".
- **`action` and `redirect="false"` are both required** on `<Dial>`. Without
  them Vobiz re-fetches the answer URL when `<Dial>` ends and re-executes the
  document, so one call dials the customer over and over.
- **`callerId` is mandatory on the inbound branch.** Omit it and Vobiz derives
  it from the A leg — the *caller's* number, which the account does not own — so
  B-leg creation is refused silently and the browser never rings.
- **A `Hangup` notification is not a request for instructions.** Returning
  `<Dial>` hands Vobiz a fresh call leg after the call has already ended.
- **Ignore the Endpoint API's `sip_registered`.** It reads `"false"` even when
  registration genuinely succeeded. Gate on JsSIP's `registered` event instead.

Three JsSIP settings are **not optional**, and each fails in a way that points
nowhere near the cause:

| Setting | Symptom without it |
| --- | --- |
| `session_timers: false` | `422`, surfaced as the opaque cause "SIP Failure Code", and no CDR at all |
| `pcConfig.iceServers` | Host-only candidates, "Incompatible SDP", CDR billed `0s` |
| Space-free `user_agent` | Vobiz interpolates it unescaped into a gateway URI; JsSIP's default contains a space |

## Troubleshooting

The backend log is the honest account. The field that matters is
`DialBLegUUID`: present means the call connected, empty means no B leg was ever
created, whatever the UI showed.

See [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) for symptom-driven
debugging.

## Known limitations

- **One Vobiz account per backend.** If `VOBIZ_AUTH_ID` is set, only that
  account can sign in.
- **Agents sign in with the account's Auth ID and Auth Token.** Every agent
  who uses the widget therefore holds the account's API credentials. Use SIP
  direct sign-in (endpoint username + password) for agents who should not.
- **Inbound rings every signed-in agent** whose session has the dialled
  number (or every signed-in agent, if none claims it); the first to answer
  takes the call. There is no queue, skills routing or per-number assignment.
- **Each sign-in sets a new password on that agent's endpoint**, so signing in
  from a second browser logs the first one out of SIP at its next re-register.
- **Quick tunnels are the most common cause of "it stopped working."** Use a
  stable hostname for anything beyond a demo.

## Documentation

Full guide: **https://www.vobiz.ai/docs/integrations/hubspot**

## License

[MIT](LICENSE)
