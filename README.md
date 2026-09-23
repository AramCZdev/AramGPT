# AramGPT

An AI Discord bot, powered by [OpenRouter](https://openrouter.ai). Runs on Cloudflare Workers — free to host, no server to babysit.

## Features

- Chat by pinging the bot: `@AramGPT What's 1+1?`
- `/aiprivacypolicy` — shows the bot's privacy policy
- Uses OpenRouter's free model (`openrouter/free`)
- Stays online on its own — no manual restarts (Durable Object keeps the gateway alive, a cron job revives it if Discord drops the connection)
- Per-user limits so the free API key doesn't get drained: **10 AI answers per user per day** (resets at UTC midnight) and a 5-second cooldown between calls

## How to use

Ping the bot in a channel it can see:

```
@AramGPT What's 1+1?
```

AramGPT replies. That's it.

You can also type `/aiprivacypolicy` to see the bot's privacy policy.

> Note: a freshly registered slash command can take up to **1 hour** to show up globally on Discord.

## Where is AramGPT?

No public servers currently use AramGPT.

## Can I add AramGPT to my server?

Not the hosted public bot, sorry. It runs on the free tier of the OpenRouter API, so it can't handle the whole internet.

But if you run a public server and want AramGPT, [contact me](mailto:aramcz@protonmail.com) — or host the bot yourself. It's free.

## Host it yourself

**What this tutorial covers:** hosting on Cloudflare Workers.
**What it does NOT cover:** customizing the bot, or running it on your own PC.

### Requirements

- A [Cloudflare](https://dash.cloudflare.com) account (free)
- A [Discord](https://discord.com/developers/applications) app (free)
- An [OpenRouter](https://openrouter.ai) account (free) + API key
- A GitHub account (for the Cloudflare deploy flow)
- Node.js (only for local builds / command registration)

### 1. Create the Discord app

1. Open the [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new **Application** and name it `AramGPT`
3. Go to **Installation**:
   - Disable **User Install**, keep **Guild Install** enabled
   - In the default install scopes, make sure **bot** is checked
   - Under bot permissions, add at least **Send Messages** and **View Channels**
4. Go to the **Bot** tab:
   - (Optional but nice) set an icon
   - Click **Reset Token**, copy the token, and keep it somewhere safe — you'll need it in step 3
   - Enable **Message Content Intent** (required for the bot to see pings)

### 2. Get the code

- Fork this repository on GitHub (you need your own copy so Cloudflare can connect to it)
- Clone your fork locally:

  ```bash
  git clone https://github.com/<your-username>/AramGPT.git
  cd AramGPT
  npm install
  ```

### 3. Deploy to Cloudflare

1. Go to Cloudflare → **Workers & Pages** → **Create** → **Worker** → **Deploy from GitHub** (Workers Builds)
2. Connect your GitHub account, pick your fork, and set the worker name to `aramgpt`
3. In the build settings make sure:
   - **Build command:** `npm run build`
   - **Deploy command:** `npm run deploy`
   - **Entry point:** `src/worker.js`
4. Click **Deploy**, then go to **Settings → Runtime variables and Secrets** and add two **secrets**:
   - `DISCORD_TOKEN` → the bot token from step 1
   - `OPENROUTER_API_KEY` → your OpenRouter API key (from `openrouter.ai` → API keys)
5. Click **Save and Deploy**. Let it build — if you see a deploy failure, see [Troubleshooting](#troubleshooting).

Need to change a secret later? Update it in **Settings → Runtime variables and Secrets** and redeploy — no code change required.

### 4. Register the slash command (optional)

The bot works by being pinged out of the box. Registering `/aiprivacypolicy` is a one-time step done from your machine:

```bash
# create .dev.vars in the project root:
#   DISCORD_TOKEN=<your bot token>
#   DISCORD_APP_ID=<your app ID from Developer Portal, "General Information" tab>

npm run register:commands
```

You should see: `Registered 1 command(s): /aiprivacypolicy`.

> `.dev.vars` is already in `.gitignore` — never commit your token.

### 5. Invite the bot

1. Back in the Discord Developer Portal, open your app → **Installation**
2. Copy the **Discord Provided Link**
3. Paste it in your browser, pick your server, and authorize

Done. Ping `@AramGPT` and it should answer.

## Configuration

| Variable | Where | Required | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | Cloudflare secret (+ `.dev.vars` for local command registration) | ✅ | Discord bot token |
| `OPENROUTER_API_KEY` | Cloudflare secret | ✅ | OpenRouter API key |
| `DISCORD_APP_ID` | `.dev.vars` only | for `/aiprivacypolicy` registration | Your Discord application ID (the bot's numeric ID) |

## Limits

The bot throttles usage so a free OpenRouter key isn't exhausted:

- **Per user:** 10 AI answers / day (resets at UTC midnight), 5s cooldown between requests
- **OpenRouter free tier:** ~20 requests/minute, ~50 requests/day (free account)

## Checking the bot is alive

Visit `https://aramgpt.<your-subdomain>.workers.dev/status` in a browser. A healthy bot returns:

```json
{"ok":true,"ready":true,"heartbeatIntervalMs":41250,"wsState":1,"bot":"<bot-id>","seq":4,"resume":true}
```

- `ready: true` → connected to Discord and receiving messages
- `ready: false` → connection lost; the cron job should revive it within a minute

## Troubleshooting

**`npm build` fails / "Unknown command: build"**
The build command must be `npm run build`, not `npm build`. npm removed the `npm build` alias in npm 10.

**Bot never comes online after deploy**
Check that both `DISCORD_TOKEN` and `OPENROUTER_API_KEY` are set as *secrets* in **Runtime variables and Secrets**, then redeploy. Then check `/status`.

**`/aiprivacypolicy` doesn't appear**
Global command registration can take up to 1 hour. If it's been longer, re-run `npm run register:commands` and make sure `DISCORD_APP_ID` in `.dev.vars` is the numeric application ID (not the bot username).

**Bot replies "you need to wait" frequently**
You're hitting the daily or cooldown limit. Wait 5 seconds between messages, and each user gets 10 answers per UTC day.

## License

No license yet — just don't be weird about it. Made by [AramCZ](mailto:aramcz@protonmail.com).