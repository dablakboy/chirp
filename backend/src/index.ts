// Load Vibecode proxy only in Vibecode environment
if (process.env.VIBECODE_PROJECT_ID) {
  await import("@vibecodeapp/proxy");
}
import { Hono } from "hono";
import { cors } from "hono/cors";
import "./env";
import { sampleRouter } from "./routes/sample";
import { chirpRouter } from "./routes/chirp";
import { turnRouter } from "./routes/turn";
import { logger } from "hono/logger";

const app = new Hono();

// CORS middleware
const allowed = [
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https:\/\/[a-z0-9-]+\.dev\.vibecode\.run$/,
  /^https:\/\/[a-z0-9-]+\.vibecode\.run$/,
  /^https:\/\/[a-z0-9-]+\.vibecodeapp\.com$/,
  /^https:\/\/[a-z0-9-]+\.vibecode\.dev$/,
  /^https:\/\/vibecode\.dev$/,
];

app.use(
  "*",
  cors({
    origin: (origin) => {
      const override = process.env.ALLOWED_ORIGINS;
      if (override === "*") return origin || "*";
      if (override) {
        const list = override.split(",").map((s) => s.trim());
        return origin && list.includes(origin) ? origin : null;
      }
      return origin && allowed.some((re) => re.test(origin)) ? origin : null;
    },
    credentials: true,
  })
);

app.use("*", logger());
app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/api/sample", sampleRouter);
app.route("/api/chirp", chirpRouter);
app.route("/api/turn-credentials", turnRouter);

// ─── WebSocket state ───────────────────────────────────────────────────────────

type ClientData = {
  userId: string;
  username: string;
  location?: string;
};

const clients = new Map<string, { ws: any; userId: string; username: string; location?: string }>();

// Backend heartbeat: ping all clients every 20s to keep connections alive through Railway's proxy
setInterval(() => {
  for (const [id, client] of clients) {
    try {
      if (client.ws.readyState === 1) { // OPEN
        client.ws.send(JSON.stringify({ type: "ping" }));
      } else {
        clients.delete(id);
      }
    } catch {
      clients.delete(id);
    }
  }
}, 20000);

const wsHandlers = {
  message(ws: any, message: string | Buffer) {
    const raw = typeof message === "string" ? message : message.toString();
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const senderId = ws.data?.userId as string | undefined;

    if (msg.type === "audio") {
      for (const [id, client] of clients) {
        if (id !== senderId) {
          try { client.ws.send(raw); } catch (_) {}
        }
      }
    } else if (msg.type === "startTalk") {
      for (const [id, client] of clients) {
        if (id !== senderId) {
          try {
            client.ws.send(JSON.stringify({
              type: "startTalk",
              userId: senderId,
              username: ws.data?.username,
            }));
          } catch (_) {}
        }
      }
    } else if (msg.type === "stopTalk") {
      for (const [id, client] of clients) {
        if (id !== senderId) {
          try {
            client.ws.send(JSON.stringify({ type: "stopTalk", userId: senderId }));
          } catch (_) {}
        }
      }
    } else if (
      msg.type === "webrtc-offer" ||
      msg.type === "webrtc-answer" ||
      msg.type === "webrtc-ice-candidate"
    ) {
      // Relay WebRTC signaling directly to the target peer
      const target = clients.get(msg.toUserId);
      if (target) {
        try {
          target.ws.send(JSON.stringify({ ...msg, fromUserId: senderId }));
        } catch (_) {}
      }
    } else if (msg.type === "ping") {
      try { ws.send(JSON.stringify({ type: "pong" })); } catch (_) {}
    } else if (msg.type === "updateLocation") {
      // Update this client's location and broadcast to others
      const client = clients.get(senderId!);
      if (client) {
        client.location = msg.location;
        for (const [id, c] of clients) {
          if (id !== senderId) {
            try {
              c.ws.send(JSON.stringify({ type: "locationUpdate", userId: senderId, location: msg.location }));
            } catch (_) {}
          }
        }
      }
    }
  },

  open(ws: any) {
    const data = ws.data as ClientData | undefined;
    if (!data?.userId) return;
    const { userId, username, location } = data;
    clients.set(userId, { ws, userId, username, location });
    console.log(`[WS] User joined: ${username} (${userId})${location ? ` [${location}]` : ""}. Total: ${clients.size}`);

    // Send current user list to the new client
    try {
      ws.send(JSON.stringify({
        type: "userList",
        users: Array.from(clients.values()).map((c) => ({
          userId: c.userId,
          username: c.username,
          location: c.location,
        })),
      }));
    } catch (_) {}

    // Notify existing clients
    for (const [id, client] of clients) {
      if (id !== userId) {
        try {
          client.ws.send(JSON.stringify({ type: "userJoined", userId, username, location }));
        } catch (_) {}
      }
    }
  },

  close(ws: any) {
    const data = ws.data as ClientData | undefined;
    if (!data?.userId) return;
    const { userId, username } = data;
    clients.delete(userId);
    console.log(`[WS] User left: ${username} (${userId}). Total: ${clients.size}`);
    for (const [, client] of clients) {
      try {
        client.ws.send(JSON.stringify({ type: "userLeft", userId }));
      } catch (_) {}
    }
  },
};

// ─── Server export ─────────────────────────────────────────────────────────────

const port = Number(process.env.PORT) || 3000;

export default {
  port,
  fetch(req: Request, server: any) {
    const url = new URL(req.url);
    if (
      url.pathname === "/ws" &&
      req.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      const userId = url.searchParams.get("userId") || crypto.randomUUID();
      const username =
        url.searchParams.get("username") ||
        `Radio_${Math.floor(Math.random() * 9000) + 1000}`;
      const location = url.searchParams.get("location") || undefined;
      const success = server.upgrade(req, { data: { userId, username, location } as ClientData });
      if (success) return undefined as any;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
    return app.fetch(req);
  },
  websocket: wsHandlers,
};
