# Setup

One-time setup, in order. Each step depends on the one before it.

You need: Node 20.12+, a Vobiz account with a number and balance (per team that signs in), a HubSpot account
with developer tools, and `cloudflared` (or ngrok) for a public HTTPS URL.

---

## 1. Prove the Vobiz account

Place a call with [rtc-demo.vobiz.ai](https://rtc-demo.vobiz.ai/). If that
fails, nothing here will work and you will spend a day debugging the wrong
layer.

## 2. Nothing account-specific to configure

There is no Vobiz Auth ID, Auth Token, number, SIP user or SIP password in
`.env`, and no endpoint to create by hand. Each agent signs in to the panel with
their own account's Auth ID and Auth Token, and the backend provisions
everything in that account (step 4). Any number of Vobiz accounts can use one
deployment.

## 3. Configure and start the backend

```bash
cp backend/.env.example backend/.env    # PUBLIC_BASE, SIGNING_SECRET, HubSpot app keys
npm install
npx webpack                             # build the widget bundle
npm start                               # :8092
cloudflared tunnel --url http://localhost:8092
```

Put the tunnel URL in `PUBLIC_BASE` and restart.

**Check the answer URL before touching any UI:**

```bash
curl -s -X POST "$PUBLIC_BASE/answer" -d "Event=Hangup"
```

Must return XML (`<Response></Response>`). A dead answer URL produces the exact
symptom people blame on registration: the customer answers, hears ringback,
then "the agent could not be reached".

## 4. What sign-in does in the agent's Vobiz account

**Vobiz account sign-in** (Auth ID + Auth Token):

1. Verifies the pair with `GET /Account/{authId}/numbers`. A non-2xx is a 401.
2. Reads every page of the account's numbers. Active, voice-enabled numbers
   become the caller-ID dropdown, and only those are accepted as caller ID.
3. Finds or creates the application `vobiz-hubspot-calling-integration` with
   `answer_url` and `hangup_url` = `$PUBLIC_BASE/answer` (POST). It reuses an
   application only if the answer URL matches exactly or the name is exactly
   that one. No other application in the account is touched.
4. Finds or creates the agent's own endpoint (alias `hubspot-<agentId>`), sets
   a fresh random password on it, and gives that password to that agent's
   browser only. Vobiz rewrites the submitted username, so the stored one is
   read back with `GET /Endpoint/{id}/`.
5. Binds the endpoint to the application with `{"app_id":"<id>"}`, checks it
   with a GET, and falls back to the documented `{"application": <id>}`.
   App ids are 17 digits, larger than JavaScript can hold exactly as a
   number, so they stay strings throughout.

Sign-in never attaches a number. **Enable inbound calls** in the panel does
that for the number the agent picks
(`POST /numbers/%2B<digits>/application {"application_id": "<id>"}`). This moves
the number off whatever application it was on, and the panel names that
application first. The `+` must be percent-encoded. `/Number/` returns a bare
`401 Unauthorised` that reads exactly like a credentials problem and is not
one.

**SIP direct sign-in** (an existing endpoint's SIP username and password, plus
a caller ID) uses no account API. Do the binding yourself first:

- **Console:** make an application with Answer URL and Hangup URL
  `$PUBLIC_BASE/answer` (POST). Set it as the endpoint's application (Voice →
  Endpoints), and attach the caller-ID number to it (Numbers).
- **API:**

  ```bash
  curl -X POST "https://api.vobiz.ai/api/v1/Account/$AUTH_ID/Endpoint/$ENDPOINT_ID/" \
    -H "X-Auth-ID: $AUTH_ID" -H "X-Auth-Token: $AUTH_TOKEN" \
    -H "Content-Type: application/json" -d '{"app_id":"'"$APP_ID"'"}'
  curl -X POST "https://api.vobiz.ai/api/v1/Account/$AUTH_ID/numbers/%2B$DIGITS/application" \
    -H "X-Auth-ID: $AUTH_ID" -H "X-Auth-Token: $AUTH_TOKEN" \
    -H "Content-Type: application/json" -d '{"application_id":"'"$APP_ID"'"}'
  ```

  Run these from your own shell. Nothing here goes into `.env`.

In SIP direct mode the backend never sees the SIP password. It records only
`SIP user → caller ID` for webhook routing. Recordings and Enable inbound
calls need account sign-in.

**Use a separate endpoint per integration.** An endpoint binds to exactly one
Vobiz application at a time, so sharing one between HubSpot and another CRM
silently breaks whichever was configured first.

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

Sign in with your Vobiz Auth ID and Auth Token (or SIP direct), pick a caller
ID, allow the microphone, wait for **Ready**, and dial. To take calls, click
**Enable inbound calls** once and pick the number.
