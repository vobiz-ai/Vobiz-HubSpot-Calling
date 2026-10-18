# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Any Vobiz account can sign in. No Auth ID, Auth Token, number or SIP
  credential in `.env`; `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN`,
  `VOBIZ_FROM_NUMBER` and `VOBIZ_SIP_*` are ignored. Each account gets this
  integration's application and per-agent endpoints at sign-in.
- Caller-ID dropdown from the account's own active, voice-enabled numbers (all
  pages); any other caller ID is refused. `X-VH-Caller-ID` on the INVITE.
- **Enable inbound calls**: the only action that attaches a number.
- Inbound routing by `ParentAuthID`, then by dialled number, per account.
- SIP direct sign-in that needs no backend credentials.
- One SIP endpoint per agent, created on first sign-in and reused afterwards.
  Inbound rings every signed-in agent; the first to answer takes the call.
- Session tokens: `/login` returns one, and every widget route requires it.
- `npm test`: black-box tests against a fake Vobiz API, run in CI.
- `DATA_DIR` (default `backend/data`, 0700) holds `agent-endpoints.json` and
  `hubspot-tokens.json` (0600). Files left in `backend/` are read until the
  next write.
- **Enable inbound calls** names the application the number moved from.
- `npm run test-account` reads the HubSpot CLI v8 config
  (`~/.hscli/config.yml`) as well as a repo-root `hubspot.config.yml`.
- `npm run calling:configure` reads `backend/.env` (the shell wins) and
  defaults `WIDGET_URL` to `<PUBLIC_BASE>/widget/`.

### Fixed

- `HUBSPOT_SCOPES` defaulted to contact scopes, so an unset value made the
  install demand CRM permissions agents lack. It now defaults to `oauth`.
- `hubspot.config.yml` (a personal access key) was not git-ignored.

- Inbound with no matching agent rang every signed-in agent, across accounts.
- Sign-in attached the selected number to the application, moving it off
  whatever app it was on.
- Any application whose name contained "hubspot" could be repointed.
- The 17-digit app id was sent as `{ app_id: <number> }`.
- Recording links were not tied to an account.
- SIP credentials could be obtained without valid Vobiz credentials
  (`/login-sip`, and `/login` with an `MA_…test…` Auth ID).
- Hardcoded SIP passwords (`vobiz123`, and a fixed one in provisioning).
- Signing in rotated the password of the account's first endpoint, whatever
  else used it, and could rewrite the answer URL of an unrelated application.
- CORS allowed any Cloudflare or ngrok quick-tunnel origin.
- The Vobiz Auth Token and SIP password were saved in `localStorage`.
- Calls were never written to the HubSpot timeline: `callCompleted` was only
  sent from the developer panel.
- CI failed on every run (no lockfile, and the audit flagged placeholder text).

## [1.0.0] — 2026-09-20

First public release.

### Added

- Outbound calling with browser audio over WebRTC.
- Inbound calling with an Accept / Decline prompt.
- Call logging to HubSpot, with duration and outcome.
- Recording playback behind an HMAC-signed, short-expiry link that carries no
  credentials.
- Setup, architecture and troubleshooting documentation.

### Notes

- The browser is the A leg: the panel sends the SIP INVITE and the backend
  answers `<Dial><Number>`. Originating to the customer over REST and bridging
  the agent in with `<Dial><User>` does not work — routing into a registered
  WebRTC endpoint is blocked platform-side. Inbound is the exception.
- Single-account by design in this release (lifted in Unreleased).

[1.0.0]: https://github.com/vobiz-ai/Vobiz-HubSpot-Calling/releases/tag/v1.0.0
