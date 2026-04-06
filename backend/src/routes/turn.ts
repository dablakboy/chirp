import { Hono } from "hono";
import { env } from "../env";

const turnRouter = new Hono();

turnRouter.get("/", async (c) => {
  // If Metered.ca API key is configured, fetch fresh time-limited credentials
  if (env.METERED_API_KEY) {
    try {
      const url = `https://${env.METERED_HOST}/api/v1/turn/credentials?apiKey=${env.METERED_API_KEY}`;
      const res = await fetch(url);
      if (res.ok) {
        const iceServers = await res.json();
        return c.json({ data: iceServers });
      }
    } catch (e) {
      console.error("[TURN] Metered.ca fetch failed, falling back:", e);
    }
  }

  // Fallback: static TURN config from env vars + Google STUN
  const iceServers: object[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  if (env.TURN_URLS && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    const urls = env.TURN_URLS.split(",").map((u) => u.trim());
    iceServers.push({ urls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
  }

  return c.json({ data: iceServers });
});

export { turnRouter };
