import { buildApp } from "./src/app.js";
import { PrismaClient } from "@prisma/client";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3001);

const app = await buildApp();

// Provide Prisma where routes expect it
app.locals = app.locals || {};
app.locals.prisma = new PrismaClient();

const shutdown = async () => {
  try { await app.locals.prisma.$disconnect(); } catch {}
  try { await app.close(); } catch {}
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  const addr = await app.listen({ host: HOST, port: PORT });
  app.log.info(`Server listening at ${addr}`);
  console.log(`✅ Server running at http://${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
