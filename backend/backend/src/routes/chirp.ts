import { Hono } from "hono";

const chirpRouter = new Hono();

chirpRouter.get("/health", (c) =>
  c.json({ data: { status: "ok", service: "chirp" } })
);

export { chirpRouter };
