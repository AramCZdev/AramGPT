import { DurableObject } from "cloudflare:workers";

const DISCORD_API = "https://discord.com/api/v10";
const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "openrouter/free";
const GATEWAY_VERSION = "10";
const MAX_MESSAGE_LENGTH = 2000;

const DAILY_LIMIT = 10;
const COOLDOWN_MS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;
const AI_TIMEOUT_MS = 30 * 1000;
const HEARTBEAT_MARGIN_MS = 3000;
const PRESENCE_REFRESH_MS = 5 * 60 * 1000;
const RECONNECT_DELAY_MS = 3000;

const INTENTS = 33281;

const KEY_META = "meta";
const KEY_RATE = "rate";
const KEY_CONV = "conv:";

const NO_RESUME_CODES = new Set([4000, 4001, 4002, 4004, 4005, 4007, 4008, 4009, 4010, 4013, 4014]);

export class DiscordGateway extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.ws = null;
    this.heartbeatIntervalMs = 41250;
    this.heartbeatPending = false;
    this.seq = null;
    this.sessionId = null;
    this.resumeUrl = null;
    this.botId = null;
    this.ready = false;
    this.lastPresenceSent = 0;
    this.reconnectScheduled = false;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    switch (path) {
      case "/connect":
        await this.connect();
        break;
      case "/status":
        return new Response(JSON.stringify(this.statusInfo()), {
          headers: { "content-type": "application/json" }
        });
      case "/ensure":
      default:
        await this.connect();
        break;
    }

    return new Response(JSON.stringify(this.statusInfo()), {
      headers: { "content-type": "application/json" }
    });
  }

  async alarm() {
    try {
      const now = Date.now();

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        if (this.heartbeatPending) {
          this.ws.close(4000, "missed heartbeat ack");
          this.ws = null;
          this.scheduleHeartbeat(now + RECONNECT_DELAY_MS);
          return;
        }
        this.ws.send(JSON.stringify({ op: 1, d: this.seq }));
        this.heartbeatPending = true;
      } else if (!this.ws) {
        await this.connect();
      }

      if (this.ready && this.ws && this.ws.readyState === WebSocket.OPEN) {
        if (now - this.lastPresenceSent >= PRESENCE_REFRESH_MS) {
          this.setPresence();
        }
      }

      this.scheduleHeartbeat(now + this.heartbeatIntervalMs);
    } catch (error) {
      console.error("alarm error:", error);
      this.scheduleHeartbeat(Date.now() + this.heartbeatIntervalMs);
    }
  }

  statusInfo() {
    return {
      ok: this.ready,
      ready: this.ready,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      wsState: this.ws ? this.ws.readyState : -1,
      bot: this.botId,
      seq: this.seq,
      resume: Boolean(this.sessionId)
    };
  }

  async connect() {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    if (!this.env.DISCORD_TOKEN) {
      throw new Error("DISCORD_TOKEN is not set");
    }

    const meta = await this.ctx.storage.get(KEY_META);
    this.sessionId = meta?.sessionId ?? null;
    this.resumeUrl = meta?.resumeUrl ?? null;
    this.seq = meta?.seq ?? null;

    if (!this.botId) {
      try {
        const user = await this.getBotUser();
        this.botId = user.id;
      } catch (error) {
        console.error("failed to fetch bot user:", error);
      }
    }

    const gateway = await this.getGateway();

    this.reconnectScheduled = false;

    const ws = new WebSocket(`${gateway.url}?v=${GATEWAY_VERSION}&encoding=json`);

    ws.addEventListener("open", () => {
      console.log("Discord gateway socket open");
    });

    ws.addEventListener("message", (event) => {
      this.handleMessage(event.data).catch((error) => {
        console.error("gateway message handler failed:", error);
      });
    });

    ws.addEventListener("close", (event) => {
      console.warn(`Discord gateway closed (code ${event.code}, clean=${event.wasClean})`);
      if (this.ws === ws) {
        this.ws = null;
      }
      this.ready = false;
      const canResume = !NO_RESUME_CODES.has(event.code);
      this.scheduleHeartbeat(Date.now() + RECONNECT_DELAY_MS);
      if (canResume) {
        this.sessionId = this.sessionId;
        this.resumeUrl = this.resumeUrl;
      } else {
        this.sessionId = null;
        this.resumeUrl = null;
      }
      void this.ctx.storage.put(KEY_META, {
        sessionId: this.sessionId,
        resumeUrl: this.resumeUrl,
        seq: this.seq
      }).catch(() => {});
    });

    ws.addEventListener("error", () => {
      console.error("Discord gateway socket error");
    });

    this.ws = ws;
  }

  async getGateway() {
    const response = await fetch(`${DISCORD_API}/gateway/bot`, {
      headers: { Authorization: `Bot ${this.env.DISCORD_TOKEN}` }
    });

    if (!response.ok) {
      throw new Error(`gateway/bot returned ${response.status}: ${await response.text()}`);
    }

    return response.json();
  }

  async getBotUser() {
    const response = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bot ${this.env.DISCORD_TOKEN}` }
    });

    if (!response.ok) {
      throw new Error(`users/@me returned ${response.status}: ${await response.text()}`);
    }

    return response.json();
  }

  async handleMessage(raw) {
    let frame;

    try {
      const data = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      frame = JSON.parse(data);
    } catch (error) {
      console.error("failed to parse gateway frame:", error);
      return;
    }

    const { op, d, s, t } = frame;

    if (s !== undefined && s !== null) {
      this.seq = s;
    }

    switch (op) {
      case 0:
        await this.handleDispatch(t, d);
        break;
      case 1:
        this.sendHeartbeatAck();
        break;
      case 7:
        if (this.ws) {
          this.ws.close(4000, "reconnect requested");
        }
        break;
      case 9:
        this.sessionId = null;
        this.resumeUrl = null;
        void this.ctx.storage.put(KEY_META, { sessionId: null, resumeUrl: null, seq: this.seq }).catch(() => {});
        break;
      case 10: {
        this.heartbeatIntervalMs = d.heartbeat_interval;
        this.sendIdentify();
        this.scheduleHeartbeat(Date.now() + this.heartbeatIntervalMs);
        break;
      }
      case 11:
        this.heartbeatPending = false;
        break;
      default:
        break;
    }
  }

  async handleDispatch(t, d) {
    switch (t) {
      case "READY":
        this.sessionId = d.session_id;
        this.resumeUrl = d.resume_gateway_url ?? null;
        this.botId = d.user?.id ?? this.botId;
        this.ready = true;
        this.setPresence();
        void this.ctx.storage.put(KEY_META, {
          sessionId: this.sessionId,
          resumeUrl: this.resumeUrl,
          seq: this.seq
        }).catch(() => {});
        console.log(`Logged in as ${d.user?.username ?? "unknown"}`);
        break;
      case "RESUMED":
        this.ready = true;
        this.setPresence();
        console.log("Discord session resumed");
        break;
      case "MESSAGE_CREATE":
        await this.onMessageCreate(d);
        break;
      default:
        break;
    }
  }

  sendIdentify() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    if (this.sessionId && this.resumeUrl) {
      console.log("Resuming Discord session");
      this.ws.send(
        JSON.stringify({
          op: 6,
          d: {
            token: this.env.DISCORD_TOKEN,
            session_id: this.sessionId,
            seq: this.seq ?? null
          }
        })
      );
    } else {
      console.log("Identifying with Discord");
      this.ws.send(
        JSON.stringify({
          op: 2,
          d: {
            token: this.env.DISCORD_TOKEN,
            intents: INTENTS,
            properties: {
              os: "Cloudflare Workers",
              browser: "AramGPT",
              device: "AramGPT"
            }
          }
        })
      );
    }
  }

  sendHeartbeatAck() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op: 11, d: null }));
    }
  }

  setPresence() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(
      JSON.stringify({
        op: 3,
        d: {
          since: 0,
          activities: [
            {
              name: "with humans",
              type: 0
            }
          ],
          status: "online",
          afk: false
        }
      })
    );

    this.lastPresenceSent = Date.now();
  }

  scheduleHeartbeat(at) {
    void this.ctx.storage.setAlarm(at).catch(() => {});
  }

  async onMessageCreate(d) {
    if (d.author?.bot) return;
    if (!d.channel_id) return;

    if (!this.isMentioned(d)) return;

    const prompt = this.extractPrompt(d);
    const now = Date.now();
    const userId = d.author.id;

    const rates = (await this.ctx.storage.get(KEY_RATE)) || { users: {} };
    const user = rates.users[userId] || { count: 0, last: 0, resetAt: now };

    if (now - user.resetAt >= DAY_MS) {
      user.count = 0;
      user.resetAt = now;
    }

    if (now - user.last < COOLDOWN_MS) {
      await this.reply(d, "Please wait a few seconds before asking again.");
      return;
    }

    if (user.count >= DAILY_LIMIT) {
      await this.reply(
        d,
        "You've used your 10 AI requests for today. Try again tomorrow."
      );
      return;
    }

    if (!prompt) {
      await this.reply(d, "Give me something to answer!");
      return;
    }

    const convoKey = `${d.channel_id}:${userId}`;
    const history = (await this.ctx.storage.get(KEY_CONV + convoKey)) || [];

    history.push({ role: "user", content: prompt });
    if (history.length > 4) {
      history.shift();
    }

    user.count += 1;
    user.last = now;
    rates.users[userId] = user;

    await this.ctx.storage.put(KEY_RATE, rates);
    await this.ctx.storage.put(KEY_CONV + convoKey, history);

    try {
      await this.sendTyping(d.channel_id);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

      const aiResponse = await fetch(OPENROUTER_API, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            {
              role: "system",
              content: `
You are AramGPT, a Discord AI bot with a personality inspired by your creator.

Personality:
- Casual, witty, sarcastic, and slightly chaotic.
- You like joking around and occasionally roasting silly decisions, but never be genuinely mean.
- You are enthusiastic about programming, Linux, Godot, game development, Discord bots, and gaming.
- You strongly prefer Linux and open-source software, and you can joke about Windows, GNOME, and other things your creator dislikes.
- You speak naturally, like a smart teenager chatting with friends, rather than like a corporate assistant.
- Keep answers useful even when joking.
- Don't overuse jokes. If the user asks a serious technical question, prioritize solving it.
- You can use occasional emojis, but don't spam them.
- Don't claim to literally be your creator. You are AramGPT, a bot inspired by their personality.
- Don't reveal or invent private information about your creator.
- If you don't know something, say so instead of making it up.
- Also your creator is AramCZ.
`
            },
            ...history
          ]
        })
      });

      clearTimeout(timeout);

      if (!aiResponse.ok) {
        throw new Error(`OpenRouter returned ${aiResponse.status}: ${await aiResponse.text()}`);
      }

      const result = await aiResponse.json();
      const answer = result.choices?.[0]?.message?.content || "I couldn't generate a response.";

      history.push({ role: "assistant", content: answer });
      if (history.length > 4) {
        history.splice(0, history.length - 4);
      }

      await this.ctx.storage.put(KEY_CONV + convoKey, history);
      await this.reply(d, this.clamp(answer));
    } catch (error) {
      console.error("AI request failed:", error);

      history.pop();
      await this.ctx.storage.put(KEY_CONV + convoKey, history);

      user.count = Math.max(0, user.count - 1);
      await this.ctx.storage.put(KEY_RATE, rates);

      await this.reply(d, "Something went wrong while contacting the AI.");
    }
  }

  isMentioned(d) {
    const content = d.content ?? "";

    if (this.botId && content.includes(`<@${this.botId}>`)) return true;
    if (this.botId && content.includes(`<@!${this.botId}>`)) return true;

    if (Array.isArray(d.mentions)) {
      return d.mentions.some((m) => m && m.id === this.botId);
    }

    return false;
  }

  extractPrompt(d) {
    const content = d.content ?? "";

    if (this.botId) {
      const globalTag = new RegExp(`<@!?${this.botId}>`, "g");
      return content.replace(globalTag, "").trim();
    }

    return content.trim();
  }

  clamp(text) {
    if (text.length <= MAX_MESSAGE_LENGTH) {
      return text;
    }

    return `${text.slice(0, MAX_MESSAGE_LENGTH - 20)}\n\n...too long`;
  }

  async sendTyping(channelId) {
    try {
      await fetch(`${DISCORD_API}/channels/${channelId}/typing`, {
        method: "POST",
        headers: { Authorization: `Bot ${this.env.DISCORD_TOKEN}` }
      });
    } catch (error) {
      console.error("sendTyping failed:", error);
    }
  }

  async reply(d, content) {
    const body = { content };

    if (d.message_reference?.message_id || d.id) {
      body.message_reference = {
        channel_id: d.channel_id,
        message_id: d.id,
        fail_if_not_exists: false
      };
    }

    const response = await fetch(`${DISCORD_API}/channels/${d.channel_id}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${this.env.DISCORD_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      console.error(`reply failed with ${response.status}:`, await response.text());
    }
  }
}