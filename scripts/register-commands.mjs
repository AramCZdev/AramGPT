import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv() {
  const env = {};
  const text = readFileSync(resolve(process.cwd(), ".dev.vars"), "utf8");
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) {
      env[match[1]] = match[2].trim();
    }
  }
  return env;
}

const env = loadEnv();
const token = env.DISCORD_TOKEN;
if (!token) {
  console.error("DISCORD_TOKEN not found in .dev.vars");
  process.exit(1);
}

const appId = env.DISCORD_APP_ID;
if (!appId) {
  console.error("DISCORD_APP_ID not found in .dev.vars");
  process.exit(1);
}

const commands = [
  {
    name: "aiprivacypolicy",
    description: "Show the AramGPT privacy policy",
    dm_permission: true
  }
];

const response = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify(commands)
});

const body = await response.json();
if (!response.ok) {
  console.error(`Registration failed (${response.status}):`, JSON.stringify(body));
  process.exit(1);
}

console.log(`Registered ${body.length} command(s):`, body.map((c) => `/${c.name}`).join(", "));