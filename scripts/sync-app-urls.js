#!/usr/bin/env node
/**
 * Write PUBLIC_BASE from backend/.env into src/app/app-hsmeta.json.
 *
 * The app manifest has to name your public host in two places — redirectUrls
 * (the OAuth callback) and permittedUrls.iframe (or HubSpot refuses to frame
 * the widget). Those cannot be committed, because on a quick tunnel the
 * hostname changes every restart and whatever is in git is wrong for everyone.
 *
 * The committed file therefore holds a placeholder, and this fills it in.
 *
 * Run it after every tunnel restart, then `npx hs project upload`. A stale
 * host here means the install redirect fails and the widget renders blank, with
 * no error that names the cause.
 *
 *   npm run sync-urls
 */
const fs = require("node:fs");
const path = require("node:path");

const ENV = path.join(__dirname, "..", "backend", ".env");
const MANIFEST = path.join(__dirname, "..", "src", "app", "app-hsmeta.json");

let base = (process.env.PUBLIC_BASE || "").trim();
if (!base) {
  try {
    const env = fs.readFileSync(ENV, "utf8");
    base = ((env.match(/^PUBLIC_BASE=(.*)$/m) || [])[1] || "").trim();
    if (!base) base = ((env.match(/^TUNNEL_URL=(.*)$/m) || [])[1] || "").trim();
  } catch { /* fall through to the error below */ }
}
if (!base) {
  console.error("No PUBLIC_BASE. Set it in backend/.env or in the environment.");
  process.exit(1);
}
if (!base.startsWith("https://")) {
  console.error(`PUBLIC_BASE must be https (HubSpot will not frame anything else). Got: ${base}`);
  process.exit(1);
}
base = base.replace(/\/+$/, "");

const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const cfg = manifest.config;
cfg.auth.redirectUrls = [`${base}/hubspot/callback`];
cfg.permittedUrls.iframe = [base];
cfg.permittedUrls.fetch = Array.from(new Set(["https://api.hubapi.com", base]));
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

console.log("✓ src/app/app-hsmeta.json updated");
console.log(`  redirect  ${cfg.auth.redirectUrls[0]}`);
console.log(`  iframe    ${base}`);
console.log("\n  Next: npx hs project upload --account=<portalId>");
console.log("        npm run calling:configure   (the widget URL moved too)");
console.warn("\n  ⚠  src/app/app-hsmeta.json is now DIRTY and must not be committed.");
console.warn("     It is committed with a YOUR_PUBLIC_HOST placeholder on purpose:");
console.warn("     a tunnel hostname in git is wrong for everyone else, and the CI");
console.warn("     credential audit fails the build on it.");
console.warn("     Restore before committing:  git checkout -- src/app/app-hsmeta.json");
