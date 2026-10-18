# Security policy

## Reporting a vulnerability

Email **security@vobiz.ai** (or **support@vobiz.ai**). Please do not open a
public issue for a security problem.

Include what you found, how to reproduce it, and what an attacker could do with
it. We will acknowledge your report and keep you updated.

## What this software protects, and what it does not

Be clear-eyed about this before deploying. The list below is honest rather than
reassuring.

### What is handled

**The browser never holds your Vobiz Auth Token.** It is posted once at sign-in
and exchanged for an opaque session token.

**Recording links carry no credentials.** They are HMAC-signed with a short
expiry, and the audio is fetched server-side. A link that leaks grants nothing
but that one recording, and only until it expires.

**Recording playback takes no caller-supplied URL.** The backend fetches audio
only for a recording ID in a signed link, only from an allowlist of Vobiz and
cloud storage hosts, and
sends account credentials only to Vobiz's own hosts.

**CORS is an allowlist**, not `*`.

### What is not handled

**Sign-in uses the account's Auth ID and Auth Token.** The backend checks them
against Vobiz and returns an opaque session token; SIP credentials are served
only against that token, and only the agent's own. But every agent who signs in
this way holds the account's API credentials.

**The agent id is chosen by the browser.** It decides which endpoint an agent
gets; it does not prove who they are. Anyone holding the account's Auth Token
can sign in as any agent id.

**Secrets live on the host.** The HubSpot client secret is in `backend/.env`,
and the HubSpot OAuth tokens are in `backend/hubspot-tokens.json` (mode 0600).
There is no secret manager, no encryption at rest, and no rotation. Treat the
host as sensitive.

**Vobiz webhooks are not signature-checked.** The webhook routes return call
instructions only for signed-in agents and their own numbers.

**A quick tunnel is not production infrastructure.** Its hostname changes on
every restart and it is publicly reachable while it is up.

Deploying this as-is for real customer traffic needs, at minimum: an identity
provider in front of `/login` (so agents never see the Auth Token), a stable
hostname, and secrets held somewhere better than a file.
