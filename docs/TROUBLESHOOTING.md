# Troubleshooting

Organised by **what you see**, because several of these report the wrong cause.

Every one of these was hit for real while getting this working.

---

## The widget

### "Calling is offline" in the HubSpot panel

Nothing is offline. HubSpot loaded the widget, the widget failed to initialise,
and HubSpot interpreted the silence as a dead connection.

Check the backend log for a 404. The classic one:

```
404 GET /demo-minimal-js.bundle.js
```

The widget URL had **no trailing slash**, so the page's relative
`<script src="demo-minimal-js.bundle.js">` resolved against the site root
instead of `/widget/`. The bundle 404s, JsSIP never loads, the widget never
calls `cti.initialized()`.

Fixed in the backend — `/widget` redirects to `/widget/` and the bundle is also
served from the root. If you change the widget hosting, keep both.

Other causes: the bundle was never built (`npx webpack`), or the tunnel died.

### "Login failed: Failed to fetch"

The widget is calling a backend it cannot reach. Almost always one of:

- **Mixed content.** An `http://` backend URL inside HubSpot's HTTPS iframe is
  blocked by the browser. `BACKEND_URL` defaults to the widget's own origin for
  exactly this reason; only override it with `?backendUrl=` for split
  deployments, and only over HTTPS.
- Wrong port, or the backend is not running.
- CORS: the origin is not on the backend's allowlist.

The browser console names the real cause; the widget message does not.

### The widget never appears — HubSpot offers its own dialer

Use **"Have another call provider? Change provider"** at the bottom of the call
popover. Provider selection is there, not in Settings.

If Vobiz Calling is not listed:

- `isReady: false` hides the app from the picker. `npm run calling:show` to
  check, `npm run calling:configure` to fix.
- The app is installed in a different portal than the one you are in.
- The calling extension was never registered — `calling:show` returns 404.

---

## Registration

### Status never reaches "Ready"

The widget fetched `/agent/{id}` and the SIP stack did not come up.

| What you see | Cause |
| --- | --- |
| `401` on `/agent/…` | Not signed in. SIP credentials are session-gated |
| "Registration failed" | Wrong `VOBIZ_SIP_USER` — almost always the username you *submitted* rather than the one Vobiz *stored* |
| Stuck on "Connecting…" | Backend unreachable, or it crashed — check the log |
| No microphone | The iframe was denied mic permission; the call will ring and connect to silence |

**Ignore the Endpoint API's `sip_registered`.** It reads `"false"` even when
registration genuinely succeeded, on every endpoint on the account. The widget
gates on JsSIP's `registered` event instead, which is the only reliable signal.

---

## Calls

### `DialBLegUUID` is the field that matters

```
DIAL RESULT status=… bleg=abc-123      → connected
DIAL RESULT status=… bleg=(none…)      → no B leg was ever created
```

An empty B leg means the destination was unreachable, or the caller ID is not a
number this account owns. It is the single most useful diagnostic here, and it
disagrees with the UI often enough to be worth checking first.

### No `WEBHOOK /answer` line at all

Vobiz never fetched the answer URL, so it had no instructions.

- The SIP endpoint is not bound to an application → `POST /setup-inbound`
- `PUBLIC_BASE` is stale — the tunnel restarted and got a new hostname
- The tunnel is down

### The customer answers, hears ringback, then "the agent could not be reached"

Two very different causes, same symptom:

1. **A dead answer URL.** Vobiz fetched a 404 page instead of XML. Curl it.
2. **`<Dial><User>` naming an endpoint that is not registered** — for example a
   placeholder identity out of `agents.json` rather than `VOBIZ_SIP_USER`.

### No CDR exists at all

`422 Session Interval Too Small`. The call was refused before it was created, so
nothing was written. JsSIP surfaces this as the opaque cause "SIP Failure Code".

Cause: missing `session_timers: false`.

### A CDR exists but is billed `0s`

SDP/ICE. The offer or answer carried host-only candidates, Vobiz logged
`PrivateIP … Detected in SDP`, and the leg was torn down before connecting.

Cause: missing `pcConfig.iceServers`. It is needed on **both** the outbound
offer and the inbound answer.

### One call dials the customer repeatedly

`<Dial>` is missing `action` and `redirect="false"`. Without them Vobiz
re-fetches the answer URL when the dial ends and re-executes the whole document.

Related: an `Event=Hangup` request is **not** a request for instructions.
Answer it with an empty `<Response></Response>`; returning `<Dial>` originates a
fresh leg after the call already ended.

### The caller hears a bogus "Busy"

`<Record>` was nested inside `<Dial>`. It must be a self-closing **sibling
before** it — FreeSWITCH rejects the nested form.

### Inbound rings nothing, and no B-leg CDR exists

`<Dial>` had no `callerId`. Vobiz then derives it from the A leg, which on an
inbound call is the *caller's* number — one this account does not own — so
B-leg creation is refused outright and silently.

Use the DID that was actually dialled, normalised to E.164. Inbound `To` arrives
as `0XXXXXXXXXX`, `91XXXXXXXXXX` or `+91XXXXXXXXXX`, and only the last is
usable.

---

## The three client settings

All three live in `source/index.js`, all three are required, and all three fail
in ways that point nowhere near the cause.

| Setting | Symptom without it |
| --- | --- |
| `session_timers: false` | `422`, surfaced as "SIP Failure Code", **no CDR at all** |
| `pcConfig.iceServers` | host-only candidates, "Incompatible SDP", CDR billed `0s` |
| space-free `user_agent` | Vobiz interpolates it unescaped into a gateway URI; JsSIP's default contains a space |

---

## HubSpot setup

### "Your account doesn't have access to developer tools"

Developer tools are gated separately from the CRM. Grant **Developer tools
access** on the user, or assign a **Developer seat**. See
[SETUP_GUIDE](SETUP_GUIDE.md#5-get-hubspot-developer-access).

### "You don't have the right permissions to install"

Listing `contacts-writer`, team contact visibility, custom object editor,
`mam-reports-virtual-user`.

This is **over-scoping**, not an account problem. Check what the app actually
requests — this one asks for `oauth` alone and installs cleanly. If you added
CRM scopes, that is the cause.

### "There was a problem fetching approvers"

The "request approval" flow has nobody to ask, because you are the only user on
the portal. It is a dead end, not a wait.

Install into a developer test account instead: `npm run test-account`.

### `hs project upload` fails

- "Cannot read properties of undefined (reading 'tokenInfo')" — the CLI config
  has no cached token. Run `hs init`.
- "No config file found" despite the file existing — the YAML is malformed.
  A duplicate key does this.
- It asks to create the project — pass `--force`.

### The calling settings endpoint 404s

A first-time `PATCH` 404s because the settings do not exist yet. **POST**
creates them. `scripts/configure-calling.js` POSTs and falls back to PATCH.

A 404 here reads like a wrong App ID, and usually is not.

---

## After a tunnel restart

A quick tunnel gets a new hostname every restart, and **four** things go stale
together. This is the most common cause of "it worked yesterday":

1. `PUBLIC_BASE` in `backend/.env`
2. the Vobiz application's `answer_url` — re-run `POST /setup-inbound`
3. `src/app/app-hsmeta.json` — `npm run sync-urls`, then `npx hs project upload`
4. the HubSpot widget URL — re-run `npm run calling:configure`

Use a stable hostname for anything beyond a demo.
