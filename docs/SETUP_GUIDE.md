# Setup

One-time setup, in order. Each step depends on the one before it.

You need: Node 18+, a Vobiz account with a number and balance, a HubSpot account
with developer tools, and `cloudflared` (or ngrok) for a public HTTPS URL.

---

## 1. Prove the Vobiz account

Place a call with [rtc-demo.vobiz.ai](https://rtc-demo.vobiz.ai/). If that
fails, nothing here will work and you will spend a day debugging the wrong
layer.

## 2. Create the SIP endpoint

```bash
curl -X POST "https://api.vobiz.ai/api/v1/Account/$AUTH_ID/Endpoint/" \
  -H "X-Auth-ID: $AUTH_ID" -H "X-Auth-Token: $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username":"hsagent","password":"<choose one>","alias":"HubSpot Agent"}'
```

> **Vobiz rewrites the username you submit.** Send `hsagent` and the stored
> username comes back as something like `hsagentXXXXXXXXXXXXXXXXXXXX`.
> Read the stored `username` out of the response — that is what registers, and
> what `VOBIZ_SIP_USER` must contain. Registering the name you chose fails in a
> way that looks like bad credentials.

**Use a separate endpoint per integration.** An endpoint binds to exactly one
Vobiz application at a time, so sharing one between HubSpot and another CRM
silently breaks whichever was configured first.

## 3. Configure and start the backend

```bash
cp backend/.env.example backend/.env    # then fill it in
npm install
npx webpack                             # build the widget bundle
npm start                               # :8092
cloudflared tunnel --url http://localhost:8092
```

Put the tunnel URL in `PUBLIC_BASE` and restart.

**Check the answer URL before touching any UI:**

```bash
curl -s -X POST "$PUBLIC_BASE/answer" \
  -d "From=sip:x@registrar.vobiz.ai&To=91XXXXXXXXXX&RouteType=sip"
```

Must return `<Response>` containing `<Dial …><Number>`. A dead answer URL
produces the exact symptom people blame on registration: the customer answers,
hears ringback, then "the agent could not be reached".

## 4. Point Vobiz at the backend

With the widget signed in, `POST /setup-inbound` does all three steps —
creates the application, binds the endpoint, attaches the DID:

```bash
curl -X POST "$PUBLIC_BASE/setup-inbound" \
  -H 'Content-Type: application/json' -d '{"agentId":"test-agent"}'
```

Two undocumented things it works around:

- The endpoint-binding field is **`app_id`**, not the documented `application`,
  which is silently ignored and still returns `202 "changed"`.
- DID attachment is `POST /numbers/%2B<e164>/application` with
  `{"application_id": …}`. The `+` must be percent-encoded, and `/Number/`
  returns a bare `401 Unauthorised` that reads exactly like a credentials
  problem and is not one.

## 5. Get HubSpot developer access

Developer tools are gated separately from the CRM.

- **Non-seat-based accounts**: Settings → Users & Teams → your user →
  Permissions → **Developer tools access**. Super admins normally have it.
- **Seat-based accounts**: assign a **Developer seat**. They cost nothing extra
  and do not count against CRM user limits.

If `/developer-overview/<portalId>` says "Your account doesn't have access to
developer tools", this is why.

## 6. Create the app

Legacy public app creation was **sunset on 23 June 2026**. Apps are now
developer projects.

```bash
npm install -g @hubspot/cli
hs init                                  # browser auth, once
npx hs project upload --account=<portalId> --force
npx hs project info --account=<portalId> # prints the App ID under "App"
```

> **The App ID is only available here.** It is absent from the project payload,
> and the legacy `/integrations/v1/applications` endpoints 404 now that legacy
> apps are sunset. Everything about the calling extension is keyed on it.

`src/app/app-hsmeta.json` is committed with a `YOUR_PUBLIC_HOST` placeholder,
because on a quick tunnel the real host changes every restart. Fill it in before
uploading:

```bash
npm run sync-urls        # writes PUBLIC_BASE into redirectUrls and permittedUrls
```

`distribution` is `private` in `src/app/app-hsmeta.json`. Marketplace
distribution demands listing assets that do not exist yet and blocks the upload;
switch it when you actually submit.

### Scopes

The app requests **`oauth` and nothing else**, deliberately.

HubSpot creates the call engagement itself from the SDK messages the widget
sends, using the **agent's own session** — not this app's token. No CRM scope is
involved.

Asking for `crm.objects.contacts.read`/`write` makes the install demand four
user permissions (`contacts-writer`, team contact visibility, custom object
editor, `mam-reports-virtual-user`) for capabilities the app never uses. A
normal agent does not have those, and the install simply fails.

Add scopes back only when the backend actually calls the CRM API — that is, when
`hubspotFetch` in `backend/hubspot-oauth.js` gets its first caller. Keep
`HUBSPOT_SCOPES` in `.env` matching `requiredScopes`, or the consent screen and
the token exchange disagree.

## 7. Register the calling extension

**Calling is not a project feature.** There is no `calling/` directory in a
project: `hs project upload` creates the app and nothing else. The widget URL,
its size, and inbound support live behind a separate settings API.

```bash
HUBSPOT_APP_ID=<id> HUBSPOT_DEVELOPER_API_KEY=<key> \
  WIDGET_URL=https://<host>/widget npm run calling:configure

npm run calling:show     # read back what HubSpot has
```

- The widget URL must **also** appear in `permittedUrls.iframe` in
  `src/app/app-hsmeta.json`, or HubSpot refuses to frame it.
- `isReady` defaults on. Set `--not-ready` only for production gating: while
  false, the app is hidden from the provider picker, which looks exactly like a
  failed install.
- The settings endpoint needs **POST** the first time. A first-time `PATCH`
  404s, which reads like a wrong App ID. The script handles this.

## 8. Install into a test account

Installing a calling app requires the installing **user** to hold CRM
permissions. If you are the only user on the portal, HubSpot's "request
approval" flow has nobody to ask and dies with *"There was a problem fetching
approvers"* — a dead end, not a transient error.

Developer test accounts have full permissions and are the intended place to test
an app before listing:

```bash
npm run test-account "Vobiz Calling Test"
```

Then open `https://<host>/hubspot/install` and **select the test account** on
the consent screen. You should land on "Connected to HubSpot".

Confirm: `curl -s "$PUBLIC_BASE/hubspot/status"` → `"connected": true`.

## 9. Select the provider and call

Open a contact **with a phone number**, click **Call**, then
**"Have another call provider? Change provider"** → **Vobiz Calling**.

Provider selection lives in that popover, not in Settings → Objects or
Settings → Calling.

Sign in with the Vobiz Auth ID/Token, allow the microphone, wait for **Ready**,
and dial.
