#!/usr/bin/env node
/**
 * Configure the calling extension on a HubSpot app.
 *
 * Calling is NOT a developer-project feature — there is no calling/ directory
 * in a project. `hs project upload` creates the app; everything about the
 * calling widget (its URL, size, and whether inbound is allowed) lives behind
 * this settings API and has to be set separately.
 *
 * Two things here are load-bearing:
 *
 *   url   — the iframe HubSpot loads as the softphone. It must be public HTTPS
 *           and must also appear in permittedUrls.iframe in app-hsmeta.json,
 *           or HubSpot refuses to frame it and the widget renders blank.
 *
 *   supportsInboundCalling — off by default. Until it is on, HubSpot ignores
 *           every incomingCall() the widget sends: the SIP leg rings the
 *           browser, the CRM shows nothing, and nothing is logged. That reads
 *           as a telephony fault and is not one.
 *
 * Usage:
 *   HUBSPOT_APP_ID=... HUBSPOT_DEVELOPER_API_KEY=... \
 *   WIDGET_URL=https://host/widget node scripts/configure-calling.js
 *
 *   --no-inbound            leave inbound disabled
 *   --no-calling-window     do not use HubSpot's detached calling window
 *   --show                  print the current settings and exit
 */
const APP_ID = (process.env.HUBSPOT_APP_ID || "").trim();
const API_KEY = (process.env.HUBSPOT_DEVELOPER_API_KEY || "").trim();
const WIDGET_URL = (process.env.WIDGET_URL || "").trim();
const NAME = (process.env.CALLING_APP_NAME || "Vobiz Calling").trim();

// The version segment is dated and moves. Override if HubSpot publishes a newer
// one than this was written against.
const VERSION = (process.env.HUBSPOT_CALLING_API_VERSION || "2026-09").trim();

const SHOW = process.argv.includes("--show");
const INBOUND = !process.argv.includes("--no-inbound");
const CALLING_WINDOW = !process.argv.includes("--no-calling-window");

if (!APP_ID || !API_KEY) {
  console.error("Set HUBSPOT_APP_ID and HUBSPOT_DEVELOPER_API_KEY.\n");
  console.error("  App ID             Development > Projects (or Legacy Apps) > your app");
  console.error("  Developer API key  Development > Keys");
  process.exit(1);
}
if (!SHOW && !WIDGET_URL) {
  console.error("Set WIDGET_URL to the public HTTPS URL of the widget, e.g. https://<host>/widget");
  process.exit(1);
}
if (WIDGET_URL && !WIDGET_URL.startsWith("https://")) {
  console.error(`WIDGET_URL must be https. Got: ${WIDGET_URL}`);
  process.exit(1);
}

const base = `https://api.hubapi.com/crm/extensions/calling/${VERSION}/${APP_ID}/settings`;
const url = `${base}?hapikey=${encodeURIComponent(API_KEY)}`;

(async () => {
  if (SHOW) {
    const res = await fetch(url);
    console.log(`GET ${base} -> ${res.status}`);
    console.log((await res.text()).slice(0, 800));
    process.exit(res.ok ? 0 : 1);
  }

  const body = {
    name: NAME,
    url: WIDGET_URL,
    width: 400,
    height: 600,
    // isReady controls whether the provider is offered to users. It can hide
    // the app from the provider picker entirely, which looks like a failed
    // install. Default it on for test accounts and pass --not-ready to keep an
    // app out of production.
    isReady: !process.argv.includes("--not-ready"),
    // Off by default. Turning it on makes the install demand a "Custom object
    // unassigned editor" permission that a normal agent does not have, for a
    // capability this widget does not use — calls are placed from contacts.
    supportsCustomObjects: process.argv.includes("--custom-objects"),
    supportsInboundCalling: INBOUND,
    usesCallingWindow: CALLING_WINDOW,
  };

  // POST creates the settings the first time; PATCH updates them afterwards.
  // A first-time PATCH 404s, which reads like a wrong app id and is not.
  let res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 409 || res.status === 400) {
    res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  const text = await res.text();
  if (!res.ok) {
    console.error(`✗ HubSpot returned ${res.status}`);
    console.error(text.slice(0, 600));
    if (res.status === 401) console.error("\n  A 401 is the developer API key, not the app id.");
    if (res.status === 404) console.error("\n  A 404 usually means this app id has no calling extension, or the app id is wrong.");
    process.exit(1);
  }

  console.log("✓ Calling extension configured");
  console.log(`  app                    ${APP_ID}`);
  console.log(`  widget                 ${WIDGET_URL}`);
  console.log(`  inbound calling        ${INBOUND}`);
  console.log(`  uses calling window    ${CALLING_WINDOW}`);
  console.log(`  isReady                ${!process.argv.includes("--not-ready")}`);
  console.log(`\n  ${text.slice(0, 400)}`);
})().catch((err) => {
  console.error("✗ request failed:", err.message);
  process.exit(1);
});
