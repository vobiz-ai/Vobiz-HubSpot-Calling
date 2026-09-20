const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const TUNNEL_URL_FILE = path.join(__dirname, "tunnel-url.txt");

console.log("[tunnel] Starting cloudflare tunnel for backend port 8092...");

const cloudflared = spawn("npx", ["cloudflared", "tunnel", "--url", "http://localhost:8092"], {
  shell: true
});

cloudflared.stdout.on("data", data => {
  const str = data.toString();
  console.log(str);
  const match = str.match(/https:\/\/[a-z0-9\-]+\.trycloudflare\.com/i);
  if (match) {
    const tunnelUrl = match[0];
    console.log(`\n==================================================`);
    console.log(`🚀 Cloudflare Tunnel Ready: ${tunnelUrl}`);
    console.log(`==================================================\n`);
    fs.writeFileSync(TUNNEL_URL_FILE, tunnelUrl);
  }
});

cloudflared.stderr.on("data", data => {
  const str = data.toString();
  const match = str.match(/https:\/\/[a-z0-9\-]+\.trycloudflare\.com/i);
  if (match) {
    const tunnelUrl = match[0];
    console.log(`\n==================================================`);
    console.log(`🚀 Cloudflare Tunnel Ready: ${tunnelUrl}`);
    console.log(`==================================================\n`);
    fs.writeFileSync(TUNNEL_URL_FILE, tunnelUrl);
  }
});
