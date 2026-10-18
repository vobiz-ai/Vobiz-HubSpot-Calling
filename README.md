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
| **Any Vobiz account** | Agents sign in with their own Auth ID and Auth Token. Nothing account-specific lives in `.env`. |

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

## Signing in: any Vobiz account

One deployment of this backend serves any number of Vobiz accounts. The panel
offers two sign-in modes.

**Vobiz account** (Auth ID + Auth Token, recommended). On sign-in the backend:

1. Checks the pair with `GET /api/v1/Account/{authId}/numbers`. Anything but a
   2xx is refused with a 401. There is no "this backend belongs to account X"
   check.
2. Reads every page of the account's numbers. Active, voice-enabled numbers
   fill the **caller-ID dropdown**; the backend refuses any caller ID not on
   that list.
3. Finds or creates this integration's application **in that account**,
   named `vobiz-hubspot-calling-integration`, with `answer_url` and
   `hangup_url` = `PUBLIC_BASE/answer` (POST). An application is reused only
   if its answer URL is exactly that or it has exactly that name. Other
   applications are never changed.
4. Finds or creates **one SIP endpoint per agent** (alias `hubspot-<agentId>`),
   sets a fresh random SIP password on it, and hands that password to that
   agent's browser only. The map `authId:agentId → endpoint id, username` is
   kept in `AGENT_ENDPOINT_STORE` (mode 0600, git-ignored, no passwords).
5. Binds the endpoint to the application (`{"app_id":"<id>"}`, verified with a
   GET, then `{"application": <id>}` as a fallback). App ids are 17 digits, so
   they are kept as strings throughout.

Sign-in **does not move any number.** Inbound calling starts only when an agent
clicks **Enable inbound calls** and picks a number, which attaches that DID to
the application and moves it off any app it was on. The panel shows which app
that is.

The account's Auth Token stays in the backend's memory only. It is never
written to disk, logged, or returned to the browser. After a restart, it comes
back when anyone on that account signs in again. Until then, that account's
recording links answer "sign in again".

**SIP direct** (an existing endpoint's SIP username and password, plus a
caller ID). Use this for agents who should not hold the account's API
credentials. The browser registers with the typed credentials. The password
never reaches the backend, which only records `SIP user → caller ID` so the
webhooks can route. Recordings, the number list and Enable inbound calls need
the account API, so in this mode the panel says "Sign in with your Vobiz
account to use this". Set up the endpoint and number yourself first:

- **Console:** create or open an application whose Answer URL and Hangup URL
  are `https://<PUBLIC_BASE>/answer` (POST). Under Voice → Endpoints, set the
  endpoint's application to it. Under Numbers, attach the caller-ID number to
  the same application.
- **API equivalent:**
  `POST /Application/ {"app_name":"…","answer_url":"<PUBLIC_BASE>/answer","answer_method":"POST","hangup_url":"<PUBLIC_BASE>/answer","hangup_method":"POST"}`,
  then `POST /Endpoint/{endpoint_id}/ {"app_id":"<app_id>"}`, then
  `POST /numbers/%2B<digits>/application {"application_id":"<app_id>"}`.

**How webhooks find the account.** Outbound: the SIP `From` user identifies the
agent, and so the account and the caller ID that agent picked. The panel also
sends that choice as an `X-VH-Caller-ID` header on the INVITE, which counts
only if it is one of that agent's numbers. Inbound: Vobiz's `ParentAuthID` on
the webhook names the account. Without it, the dialled number is looked up
among the numbers of signed-in accounts. Only that account's signed-in agents
ring, and `callerId` is the dialled number in E.164. If nothing matches, the
caller hears a short message and the call ends. Another account's agents never
ring.

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
and balance for each team that signs in, a HubSpot account with developer tools, and `cloudflared` (or
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
curl -s -X POST "$PUBLIC_BASE/answer" -d "Event=Hangup"
```

The last one must return XML (`<Response></Response>`). Anything else, such as a
tunnel error page or an ngrok interstitial, and every call dies silently.

**If the tunnel hostname changed**, four things go stale together: `PUBLIC_BASE`,
the Vobiz `answer_url`, `permittedUrls.iframe`, and the HubSpot widget URL.

## Configuration

Copy `backend/.env.example` to `backend/.env`. It holds deployment settings
only. There is no Vobiz Auth ID, Auth Token, number, SIP user or password in
it: agents bring their own when they sign in. `VOBIZ_AUTH_ID`,
`VOBIZ_AUTH_TOKEN`, `VOBIZ_FROM_NUMBER` and `VOBIZ_SIP_*` are ignored if set.

| Variable | Description |
| --- | --- |
| `PORT` | Backend port (default 8092) |
| `PUBLIC_BASE` | The public HTTPS URL Vobiz can reach |
| `HUBSPOT_CLIENT_ID` / `HUBSPOT_CLIENT_SECRET` | From your HubSpot app |
| `SIGNING_SECRET` | Signs recording links. Set it explicitly — a random key each boot invalidates older links |
| `RECORDING_URL_TTL_SECONDS` | How long a recording link stays valid |
| `ALLOWED_ORIGINS` | Extra CORS origins. HubSpot, localhost and `PUBLIC_BASE` are allowed by default |
| `AGENT_ENDPOINT_STORE` | Where the agent → endpoint-id map is kept (default `backend/agent-endpoints.json`, mode 0600, git-ignored, holds no passwords) |
| `SESSION_TTL_HOURS` | How long a widget sign-in lasts (default 12) |
| `VOBIZ_API_URL` / `VOBIZ_REGISTRAR` | Vobiz API and SIP hosts. Leave the defaults (the tests point the API at a local fake) |

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET/POST | `/answer`, `/inbound-answer` | The XML Vobiz executes. Branches on direction |
| POST | `/dial-status` | The `action` target of `<Dial>` — how the call ended |
| POST | `/recording-ready` | Fires when the recording is downloadable |
| POST | `/login` | Account sign-in. Checks the Auth ID / Auth Token against Vobiz, provisions the agent's endpoint, returns a session token. Every other widget route needs `Authorization: Bearer <token>` |
| POST | `/login-sip` | SIP direct sign-in: records SIP user → caller ID. Never receives the SIP password |
| POST | `/logout` | Ends the session |
| GET | `/agent` | This agent's own SIP identity (account sessions only) |
| POST | `/select-number` | Sets the outbound caller ID, from the account's own numbers |
| POST | `/setup-inbound` | **Enable inbound calls**: attaches the chosen DID to this integration's application. `/provision-hubspot-dedicated` is an alias kept for older widgets |
| GET | `/recordings`, `/cdrs` | The signed-in account's recordings and calls. Playback links are HMAC-signed over account + recording + expiry |
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

- **Account sign-in means the agent holds the account's API credentials.** Use
  SIP direct (endpoint username and password) for agents who should not.
- **Auth Tokens are kept in memory only.** After a restart, an account's
  inbound routing by number and its recording links work again once one of its
  agents signs in.
- **Inbound rings every signed-in agent of the account** that owns the call;
  the first to answer takes it. There is no queue, skills routing or
  per-number assignment.
- **SIP direct is trust-on-sign-in.** The backend cannot check that a typed
  SIP username belongs to the person typing it. Vobiz still refuses a caller ID
  the endpoint's account does not own, and an endpoint provisioned by an
  account sign-in cannot be claimed this way.
- **Each sign-in sets a new password on that agent's endpoint**, so signing in
  from a second browser logs the first one out of SIP at its next re-register.
- **Quick tunnels are the most common cause of "it stopped working."** Use a
  stable hostname for anything beyond a demo.

## Documentation

Full guide: **https://www.vobiz.ai/docs/integrations/hubspot**

## License

[MIT](LICENSE)
