# Setup guide

This guide takes you from a fresh clone to a working call in HubSpot. Do the steps in order; each one
depends on the one before it. The [README](../README.md) has the same steps in short form, plus the
configuration reference.

You need: a Vobiz account (Auth ID, Auth Token, an active voice-enabled number, call balance), a HubSpot
account where you can install apps, a public HTTPS URL for the backend, and Node.js 20.12 or newer.

Throughout, `https://calling.example.com` stands for your backend's public URL.

---

## 1. Run the backend

```bash
git clone https://github.com/vobiz-ai/Vobiz-HubSpot-Calling.git
cd Vobiz-HubSpot-Calling
npm ci
npm run build                        # builds the widget bundle into source/
cp backend/.env.example backend/.env
```

Edit `backend/.env`:

```ini
PUBLIC_BASE=https://calling.example.com
SIGNING_SECRET=<long random string, e.g. from: openssl rand -hex 32>
```

There are no Vobiz credentials in `.env`. Each agent signs in with their own Vobiz account from the
panel, and the backend sets up that account at sign-in (step 8).

Start the backend and make it reachable at your public URL (reverse proxy, load balancer or tunnel to
port 8092):

```bash
npm start
```

Check it from outside your network:

```bash
curl -s https://calling.example.com/health
curl -s -X POST https://calling.example.com/answer -d "Event=Hangup"
curl -s -o /dev/null -w '%{http_code}\n' https://calling.example.com/widget/
```

The second command must print `<Response></Response>`, and the third must print `200`. If Vobiz cannot
fetch the answer URL, calls fail.

## 2. Get HubSpot developer access

Creating the app needs developer tools, which HubSpot grants separately from the CRM.

- **Accounts without seats:** Settings → Users & Teams → your user → Permissions → turn on
  **Developer tools access**. Super admins usually have it.
- **Seat-based accounts:** assign yourself a **Developer seat**.

Without it, HubSpot says "Your account doesn't have access to developer tools".

## 3. Create the HubSpot app

The app is a HubSpot developer project (`hsproject.json` and `src/app/app-hsmeta.json`). The HubSpot CLI
is installed with the other dev dependencies.

```bash
npx hs account auth                        # authenticate the CLI with your HubSpot account, once
npm run sync-urls                          # writes PUBLIC_BASE into src/app/app-hsmeta.json
npx hs project upload --account=<portalId>
npx hs project info --account=<portalId>   # shows the App ID
```

`npm run sync-urls` fills your hostname into the manifest's OAuth redirect URL and its permitted URLs.
HubSpot will only frame the widget from a host listed there. The command edits
`src/app/app-hsmeta.json` in place; do not commit that change. Run it again, and upload again, whenever
your public hostname changes.

`npx hs account auth` stores your personal access key in `~/.hscli/config.yml`. Older CLIs wrote it to a
`hubspot.config.yml` in the repository; that file is git-ignored. Never commit either.

The app asks for the `oauth` scope only. HubSpot logs calls using the agent's own session, so the app
needs no CRM scopes. The backend requests `oauth` by default, matching the app's `requiredScopes`; leave
`HUBSPOT_SCOPES` unset (or `oauth`). Asking for contact scopes makes the install demand CRM permissions
that agents usually do not have.

## 4. Connect the backend to the app

In HubSpot, open **Development → Projects → your project → your app → Auth**. Copy the **Client ID**
and **Client secret** into `backend/.env`:

```ini
HUBSPOT_CLIENT_ID=...
HUBSPOT_CLIENT_SECRET=...
```

The redirect URL defaults to `https://calling.example.com/hubspot/callback`. If you set
`HUBSPOT_REDIRECT_URI`, it must match `redirectUrls` in the manifest exactly. Restart the backend.

## 5. Register the calling widget

The calling extension is configured through HubSpot's calling settings API, separately from the project
upload. The widget URL is your backend's `/widget/` path, with the trailing slash.

Put `HUBSPOT_APP_ID` and `HUBSPOT_DEVELOPER_API_KEY` in `backend/.env` (shell
variables override it). The widget URL defaults to `${PUBLIC_BASE}/widget/`;
set `WIDGET_URL` only to use a different one.

```bash
npm run calling:configure
```

This sets the provider name (**Vobiz Calling**, or `CALLING_APP_NAME`), the widget URL and size, turns on
inbound calling, uses HubSpot's separate calling window, and makes the provider available to users.

To read back what HubSpot has stored:

```bash
npm run calling:show
```

Options: `--no-inbound`, `--no-calling-window`, `--not-ready` (hides the provider from users).

## 6. Install the app

Open `https://calling.example.com/hubspot/install` and choose the HubSpot account to install into. You
land on **Connected to HubSpot**. Confirm with:

```bash
curl -s https://calling.example.com/hubspot/status     # "connected": true
```

**Testing in a portal where you are the only user?** Installing a calling app needs a user with CRM
permissions, and HubSpot's approval request has nobody to send to. The install fails with "There was a
problem fetching approvers". Install into a **developer test account** instead: create one in HubSpot
under your developer account's test accounts, or run

```bash
npx hs account auth        # once: writes ~/.hscli/config.yml (keep it out of git)
npm run test-account "Vobiz Calling Test"
```

which reads the default account's personal access key from `~/.hscli/config.yml` (HubSpot CLI v8), or
from a `hubspot.config.yml` an older CLI wrote in the repository root. Then open `/hubspot/install`
again and choose the test account.

## 7. Choose Vobiz as the calling provider

In HubSpot, open a contact that has a phone number and click **Call**. At the bottom of the call popover,
click **Change provider** and pick **Vobiz Calling**. Each user makes this choice once.

## 8. Sign in and call

The panel opens on **Connecting**. Sign in on one of the two tabs.

**Vobiz account.** Enter the Auth ID (`MA_XXXXXXXX`) and Auth Token from the Vobiz Console → **API
credentials**. On sign-in the backend:

1. Checks the credentials with Vobiz. Wrong credentials are refused.
2. Reads your account's numbers. Active, voice-enabled numbers fill the **Calling from** dropdown.
3. Finds or creates the application `vobiz-hubspot-calling-integration` with its answer and hangup URLs
   set to `https://calling.example.com/answer` (POST). No other application is changed.
4. Finds or creates this agent's own SIP endpoint (alias `hubspot-<agent>`), sets a new random password,
   links the endpoint to the application, and sends the SIP credentials to this agent's browser.

Each HubSpot user gets their own endpoint, so any number of agents can sign in. Signing in does not
move any of your numbers.

**SIP direct.** Enter an existing endpoint's SIP username and password and the **Calling from** number
(`+91XXXXXXXXXX`). First point the endpoint and the number at an application whose answer URL is
`https://calling.example.com/answer`. The Console steps and API calls are in the
[README](../README.md#sip-direct).

When the badge shows **Ready**, allow the microphone, choose a caller ID, and dial a number with its
country code, or click a phone number in HubSpot.

## 9. Enable inbound calls

Signed in with your Vobiz account, open **Enable inbound calls**, pick the number customers should call,
and click **Enable inbound calls**. This attaches the number to `vobiz-hubspot-calling-integration` and
moves it off the application it was on before. The dropdown shows each number's current application,
and the confirmation names the application it moved from, with its ID. Do this once per number.

Calls to that number now ring every agent signed in to the panel with that Vobiz account. Answer from
the overlay. HubSpot logs the call on the matching contact's timeline.
