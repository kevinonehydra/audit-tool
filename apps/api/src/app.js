import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { auditsRoutes } from "./routes/audits.routes.js";

export async function buildApp() {
  const app = Fastify({ logger: true });

  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  });

  app.get("/health", async () => {
    return {
      ok: true,
      service: "sc-audit-copilot",
      status: "running",
      dbUrlLoaded: Boolean(process.env.DATABASE_URL),
    };
  });

  // Path B routes
  await app.register(auditsRoutes);

  return app;
}
