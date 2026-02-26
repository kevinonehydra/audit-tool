import Fastify from "fastify";
import multipart from "@fastify/multipart";
import jwt from "@fastify/jwt";
import { PrismaClient } from "@prisma/client";

import { auditsRoutes } from "./routes/audits.routes.js";
import { registerAuthRoutes } from "./routes/auth.routes.js";

export async function buildApp() {
  const app = Fastify({ logger: true });

  // Prisma (routes expect app.prisma)
  const prisma = new PrismaClient();
  app.decorate("prisma", prisma);

  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  });

  // JWT (this makes reply.jwtSign available)
  await app.register(jwt, {
    secret: process.env.JWT_SECRET || "dev-secret-change-me",
  });

  // Auth guard (used by /auth/me and any protected routes)
  app.decorate("requireAuth", async (req, reply) => {
    try {
      const payload = await req.jwtVerify();
      req.user = payload;
    } catch {
      return reply.code(401).send({ ok: false, message: "unauthorized" });
    }
  });

  app.get("/health", async () => ({
    ok: true,
    service: "sc-audit-copilot",
    status: "running",
    dbUrlLoaded: Boolean(process.env.DATABASE_URL),
  }));

  // Auth routes (registerAuthRoutes(app) registers /auth/*)
  registerAuthRoutes(app);

  // Other routes
  await app.register(auditsRoutes);

  // Graceful shutdown
  const shutdown = async () => {
    try { await prisma.$disconnect(); } catch {}
    try { await app.close(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return app;
}
