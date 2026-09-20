#!/usr/bin/env node
/**
 * Create a HubSpot developer test account.
 *
 * Why this exists: installing a calling app into a real CRM portal requires the
 * installing user to hold CRM permissions (contacts-writer, team contact
 * visibility, and some internal ones like mam-reports-virtual-user). If you are
 * the only user on that portal, HubSpot's "request approval" flow has nobody to
 * ask and fails with "There was a problem fetching approvers" — a dead end.
 *
 * A developer test account has full permissions and is the intended place to
 * test an app before it is listed.
 *
 * Usage:
 *   node scripts/create-test-account.js "My Test Account"
 *
 * Requires hubspot.config.yml with a personal access key carrying
 * developer.test_accounts.write (the default set includes it).
 */
const fs = require("node:fs");
const path = require("node:path");

const NAME = process.argv[2] || "Calling Test Account";
const CONFIG = path.join(__dirname, "..", "hubspot.config.yml");

let pak, portalId;
try {
  const cfg = fs.readFileSync(CONFIG, "utf8");
  pak = (cfg.match(/personalAccessKey:\s*(\S+)/) || [])[1];
  portalId = Number((cfg.match(/portalId:\s*(\d+)/) || [])[1]);
} catch {
  console.error("No hubspot.config.yml — run `hs init` first.");
  process.exit(1);
}
if (!pak || !portalId) { console.error("hubspot.config.yml has no personalAccessKey/portalId."); process.exit(1); }

(async () => {
  // Exchange the personal access key for a short-lived access token, the same
  // way the CLI does.
  const auth = await fetch("https://api.hubapi.com/localdevauth/v1/auth/refresh", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ encodedOAuthRefreshToken: pak, portalId }),
  });
  if (!auth.ok) { console.error(`Could not exchange the access key: ${auth.status}`); process.exit(1); }
  const { oauthAccessToken } = await auth.json();

  const res = await fetch("https://api.hubapi.com/integrators/test-portals/v2", {
    method: "POST",
    headers: { Authorization: `Bearer ${oauthAccessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ parentPortalId: portalId, accountName: NAME, accountType: "DEVELOPER_TEST" }),
  });
  const body = await res.text();
  if (!res.ok) { console.error(`✗ HubSpot returned ${res.status}`); console.error(body.slice(0, 400)); process.exit(1); }

  const acct = JSON.parse(body);
  console.log("✓ Test account created");
  console.log(`  id     ${acct.id}`);
  console.log(`  name   ${acct.accountName}`);
  console.log(`  trial  ends ${acct.trialEndsAt}`);
  console.log("\n  Install the app into it by opening /hubspot/install andselecting this account.");
})().catch((e) => { console.error("✗", e.message); process.exit(1); });
