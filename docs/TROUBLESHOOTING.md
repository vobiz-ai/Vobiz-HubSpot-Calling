# Troubleshooting

Organised by what you see. The [README](../README.md#troubleshooting) has the same problems as a quick
table. `https://calling.example.com` stands for your backend's public URL.

The backend log is the best place to start. It prints one line per webhook (`WEBHOOK POST /answer`),
the XML decision that followed, and a `DIAL RESULT` line per call.

---

## HubSpot setup

### "Your account doesn't have access to developer tools"

Developer tools are granted separately from the CRM. Turn on **Developer tools access** for your user
(Settings → Users & Teams → your user → Permissions), or assign a **Developer seat** on seat-based
accounts.

### `npx hs project upload` fails

- The CLI is not authenticated: run `npx hs init`.
- It asks whether to create the project: answer yes, or pass `--force`.

### "There was a problem fetching approvers"

Installing a calling app needs a user with CRM permissions. If you are the only user on the portal,
HubSpot's approval request has nobody to go to. Install into a developer test account
(`npm run test-account`, or create one in HubSpot), then open `/hubspot/install` again and choose it.

### The install asks for contacts, team visibility or custom-object permissions

The install is requesting CRM scopes. Set `HUBSPOT_SCOPES=oauth` in `backend/.env`, restart, and open
`/hubspot/install` again. The app needs only `oauth`.

### "Authorisation rejected" on the callback page

The callback did not match an install this backend started. Start the install from
`https://calling.example.com/hubspot/install`, finish within 10 minutes, and do not restart the backend
in between.

### "Token exchange failed"

`HUBSPOT_CLIENT_ID` or `HUBSPOT_CLIENT_SECRET` is wrong, or `HUBSPOT_REDIRECT_URI` does not match the
manifest's `redirectUrls`. Copy the values again from the app's **Auth** tab, run `npm run sync-urls`
and `npx hs project upload`, and restart.

### Vobiz Calling is not offered as a provider

In the contact's **Call** popover, use **Change provider**. If Vobiz Calling is not listed:

- The calling widget is not registered: `npm run calling:show` returns an error. Run
  `npm run calling:configure`.
- It was registered with `--not-ready`, which hides it. Run `npm run calling:configure` without it.
- The app is installed in a different portal from the one you are in.

`npm run calling:configure` returns 401 when the developer API key is wrong, and 404 when the App ID is
wrong or has no calling extension.

## The panel

### "Calling is offline"

HubSpot loaded the widget page but the widget did not start. Usually the bundle was not built
(`npm run build`) or the backend is unreachable. Open `https://calling.example.com/widget/` in a browser;
it should show the sign-in form.

### The panel is blank

HubSpot refuses to frame a host that is not in the app's permitted URLs. Run `npm run sync-urls` and
`npx hs project upload`, and make sure the widget URL registered with `npm run calling:configure` uses the
same host.

### "Failed to fetch" when signing in

The widget cannot reach the backend. Check that the backend is running and reachable over HTTPS. If you
serve the widget from a different origin than the backend, add that origin to `ALLOWED_ORIGINS`.

### "Vobiz did not accept that Auth ID and Auth Token"

Copy both again from the Vobiz Console → **API credentials**. The Auth Token is not your Console
password.

### "Could not set up a SIP endpoint for this agent"

Vobiz refused to create or update the agent's endpoint. The message includes Vobiz's status code. Check
that the account is active and can create endpoints, then sign in again.

### The status never reaches Ready

The browser could not register its SIP endpoint.

- **Vobiz account:** sign in again; each sign-in sets a fresh password.
- **SIP direct:** use the endpoint's stored username exactly as Console → Voice → Endpoints shows it, and
  its current password.
- The agent is signed in on another browser: each sign-in sets a new password, which disconnects the
  older browser. Use one browser per agent.

The **Call** button stays disabled until the badge shows **Ready**.

### "That endpoint is in use by a Vobiz account sign-in"

You tried SIP direct with an endpoint the backend created for a Vobiz account sign-in. Use the Vobiz
account tab, or a different endpoint.

## Calls

### The customer's phone never rings

Vobiz could not get instructions from your backend.

- Check the answer URL: `curl -s -X POST https://calling.example.com/answer -d "Event=Hangup"` must
  print `<Response></Response>`.
- If your public hostname changed, update `PUBLIC_BASE`, restart, and sign in again. Sign-in points the
  `vobiz-hubspot-calling-integration` application at the new URL.
- **SIP direct:** the endpoint must be linked to an application whose answer URL is your backend.

If there is no `WEBHOOK` line in the backend log for the call, Vobiz never reached the backend.

### The call ends straight away

The backend log shows why, after `-> ... hanging up`:

- `has no caller ID`: choose a number under **Calling from**. Only active, voice-enabled numbers are
  listed.
- `which no signed-in agent owns`: the agent's sign-in expired or the backend restarted. Sign in again.

### The call fails although the number is correct

Look at the `DIAL RESULT` line. If it shows no B leg, Vobiz did not start the call to the customer:
the number is unreachable, or the caller ID is not a number your account owns. Check the number's
format (with country code) and the account's balance.

### No audio

Allow microphone access for HubSpot in the browser, and check that no other application holds the
microphone.

## Inbound

### Callers hear "Sorry, no one is available"

No agent of the Vobiz account that owns the number is signed in to the panel. This also happens right
after the backend restarts, until an agent signs in again.

### Calls to the number do not reach the panel

The number is not attached to the integration's application. Sign in with the Vobiz account and click
**Enable inbound calls** for that number. Another tool can move the number back to a different
application; enable it again if that happens.

### The browser rings but HubSpot shows nothing

Inbound calling is off in HubSpot's calling settings. Run `npm run calling:configure` without
`--no-inbound`.

## Recordings

### The list says "Sign in with your Vobiz account to use this"

You are signed in with SIP direct. Recordings need the Vobiz account sign-in.

### "Sign in to the calling panel again to play this recording"

The backend restarted and no longer holds the account's Auth Token. Sign in again and refresh the list.

### "This playback link is invalid or has expired"

Links expire after `RECORDING_URL_TTL_SECONDS` (15 minutes by default), and become invalid when
`SIGNING_SECRET` changes. Refresh the recordings list for new links. Set `SIGNING_SECRET` so links
survive restarts.

### "No audio is available for that recording yet"

Vobiz has not finished processing the recording. Wait a moment and refresh the list.
