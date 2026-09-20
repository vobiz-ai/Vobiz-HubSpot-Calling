<div align="center">

# Vobiz Calling for HubSpot

**A softphone inside HubSpot. Agents call from a contact record, talk in the browser, and HubSpot logs the call against that contact automatically.**

[![License: MIT](https://img.shields.io/badge/License-MIT-e83c00.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/Node-18%2B-339933.svg)](https://nodejs.org)

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

Requires **Node 18+**, a [Vobiz](https://console.vobiz.ai) account with a number
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
| `VOBIZ_SIP_USER` / `VOBIZ_SIP_PASSWORD` | The SIP endpoint the widget registers as |
| `PUBLIC_BASE` | The public HTTPS URL Vobiz can reach |
| `HUBSPOT_CLIENT_ID` / `HUBSPOT_CLIENT_SECRET` | From your HubSpot app |
| `SIGNING_SECRET` | Signs recording links. Set it explicitly — a random key each boot invalidates older links |
| `RECORDING_URL_TTL_SECONDS` | How long a recording link stays valid |
| `ALLOWED_ORIGINS` | CORS allowlist |

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET/POST | `/answer`, `/inbound-answer` | The XML Vobiz executes. Branches on direction |
| POST | `/dial-status` | The `action` target of `<Dial>` — how the call ended |
| POST | `/recording-ready` | Fires when the recording is downloadable |
| POST | `/start-call` | The widget's click-to-dial entry point |
| POST | `/login`, `/login-sip`, `/logout` | Session handling |
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

- **The backend is single-account.** It binds to one Vobiz account through
  `.env`, and every agent who signs in shares one SIP endpoint. Two agents on
  one install register as the same endpoint and race for calls. Real
  multi-agent use needs an endpoint per agent and an identity store.
- **`agentId` is self-asserted.** It selects a label, not an identity.
- **Quick tunnels are the most common cause of "it stopped working."** Use a
  stable hostname for anything beyond a demo.

## Documentation

Full guide: **https://www.vobiz.ai/docs/integrations/hubspot**

## License

[MIT](LICENSE)
