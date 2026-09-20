const path = require("path");
const fs = require("fs");

try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch (e) {}

const authId = process.env.VOBIZ_AUTH_ID;
const authToken = process.env.VOBIZ_AUTH_TOKEN;
const apiUrl = process.env.VOBIZ_API_URL || "https://api.vobiz.ai";

if (!authId || !authToken || authId.includes("YOUR_")) {
  console.log("Please configure VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN in backend/.env before running CDR fetch.");
  process.exit(0);
}

async function fetchCdrs() {
  console.log(`Fetching CDRs for Auth ID: ${authId}...`);
  try {
    const res = await fetch(`${apiUrl}/api/v1/Account/${authId}/cdr/recent?limit=10`, {
      headers: {
        "X-Auth-ID": authId,
        "X-Auth-Token": authToken
      }
    });
    const data = await res.json();
    console.log("CDR Fetch Result:", JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Error fetching CDRs:", err.message);
  }
}

fetchCdrs();
