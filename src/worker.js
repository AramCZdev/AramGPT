import { DiscordGateway } from "./gateway.js";

export { DiscordGateway };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const id = env.DISCORD_GATEWAY.idFromName("global");
    const stub = env.DISCORD_GATEWAY.get(id);

    if (url.pathname === "/") {
      return new Response("AramGPT is running on Cloudflare Workers.", {
        headers: { "content-type": "text/plain" }
      });
    }

    return stub.fetch(url.pathname === "/connect" ? "http://internal/connect" : url.pathname === "/status" ? "http://internal/status" : "http://internal/ensure");
  },

  async scheduled(event, env) {
    const id = env.DISCORD_GATEWAY.idFromName("global");
    const stub = env.DISCORD_GATEWAY.get(id);
    await stub.fetch("http://internal/ensure");
  }
};