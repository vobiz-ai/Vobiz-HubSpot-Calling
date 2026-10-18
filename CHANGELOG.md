# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- One SIP endpoint per agent, created on first sign-in and reused afterwards.
  Inbound rings every signed-in agent; the first to answer takes the call.
- Session tokens: `/login` returns one, and every widget route requires it.
- `npm test`: black-box tests against a fake Vobiz API, run in CI.

### Fixed

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
- Single-account by design in this release. See the known limitations in the
  README before deploying for more than one agent.

[1.0.0]: https://github.com/vobiz-ai/Vobiz-HubSpot-Calling/releases/tag/v1.0.0
