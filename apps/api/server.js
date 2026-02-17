import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import Fastify from "fastify";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import cors from "@fastify/cors";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

import { registerFindingsRoutes } from "./src/routes/findings.routes.js";

// --------------------
// Env
// --------------------
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3001);
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 5 * 1024 * 1024 * 1024);

const STORAGE_ROOT = path.resolve(process.cwd(), "storage", "audits");
const TEMPLATE_PATH = path.resolve(process.cwd(), "storage", "templates", "audit-template.docx");

const CORS_ORIGINS = String(process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// --------------------
// App + Prisma
// --------------------
const app = Fastify({ logger: true });
const prisma = new PrismaClient();

// --------------------
// CORS (register exactly once, early)
// --------------------
await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl/server-to-server

    // If env not set, allow localhost any port in dev
    if (CORS_ORIGINS.length === 0) {
      const ok = /^http:\/\/localhost:\d+$/.test(origin);
      return cb(null, ok);
    }

    return cb(null, CORS_ORIGINS.includes(origin));
  },
  credentials: true,
});

// --------------------
// Plugins
// --------------------
await app.register(jwt, { secret: JWT_SECRET });

await app.register(multipart, {
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
  },
});

// --------------------
// Helpers
// --------------------
function safeFilename(name) {
  return String(name || "file").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
}

function safeJoin(root, rel) {
  const p = path.resolve(root, rel);
  if (!p.startsWith(root)) throw new Error("Invalid path");
  return p;
}

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

function makeStorageKey({ auditId, kind, originalName }) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(auditId, kind || "file", `${ts}_${originalName}`);
}

function absPathForKey(storageKey) {
  return safeJoin(STORAGE_ROOT, storageKey);
}

function parseCsvToRows(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const obj = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = (cols[j] ?? "").trim();
    rows.push(obj);
  }
  return { headers, rows };
}

function normalizeStatus(s) {
  const v = String(s || "").trim().toLowerCase();
  if (["pass", "ok", "yes"].includes(v)) return "pass";
  if (["fail", "no"].includes(v)) return "fail";
  if (["na", "n/a"].includes(v)) return "na";
  return "unknown";
}

function computeSummary(items) {
  const summary = { total: items.length, pass: 0, fail: 0, na: 0, unknown: 0 };
  for (const it of items) {
    const k = it.status || "unknown";
    if (summary[k] === undefined) summary.unknown++;
    else summary[k]++;
  }
  return summary;
}

async function readSmallUploadToBuffer(part, limitBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of part.file) {
    size += chunk.length;
    if (size > limitBytes) throw new Error("Upload too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// --------------------
// Auth (JWT)
// --------------------
app.decorate("requireAuth", async (req, reply) => {
  try {
    await req.jwtVerify();
  } catch (err) {
    return reply.code(401).send({ ok: false, message: "Unauthorized" });
  }
});

app.get("/health", async () => {
  return {
    ok: true,
    service: "sc-audit-copilot",
    status: "running",
    dbUrlLoaded: !!process.env.DATABASE_URL,
    maxUploadBytes: MAX_UPLOAD_BYTES,
  };
});

// POST /auth/register
app.post("/auth/register", async (req, reply) => {
  try {
    const { email, password } = req.body || {};
    const cleanEmail = String(email || "").trim().toLowerCase();

    if (!cleanEmail || !password) {
      return reply.code(400).send({ ok: false, message: "email and password are required" });
    }

    const existing = await prisma.user.findUnique({ where: { email: cleanEmail } });
    if (existing) return reply.code(409).send({ ok: false, message: "User already exists" });

    const passwordHash = await bcrypt.hash(String(password), 10);

    const user = await prisma.user.create({
      data: { email: cleanEmail, passwordHash, role: "auditor" },
      select: { id: true, email: true, role: true },
    });

    return reply.code(201).send({ ok: true, user });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ ok: false, message: err?.message || "Failed to register" });
  }
});

// POST /auth/login
app.post("/auth/login", async (req, reply) => {
  try {
    const { email, password } = req.body || {};
    const cleanEmail = String(email || "").trim().toLowerCase();

    if (!cleanEmail || !password) {
      return reply.code(400).send({ ok: false, message: "email and password are required" });
    }

    const user = await prisma.user.findUnique({ where: { email: cleanEmail } });
    if (!user) return reply.code(401).send({ ok: false, message: "Invalid credentials" });

    const ok = await bcrypt.compare(String(password), user.passwordHash);
    if (!ok) return reply.code(401).send({ ok: false, message: "Invalid credentials" });

    // ✅ version-proof signing
    const token = app.jwt.sign({ sub: user.id, email: user.email, role: user.role });

    return reply.send({
      ok: true,
      token,
      user: { id: user.id, email: user.email, role: user.role },
    });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ ok: false, message: err?.message || "Failed to login" });
  }
});

// GET /auth/me
app.get("/auth/me", { preHandler: app.requireAuth }, async (req, reply) => {
  return reply.send({ ok: true, user: req.user });
});

// --------------------
// Audits (minimal: list/get/create for stage3_test.sh)
// --------------------
async function requireAuditOwner(req, reply, auditId) {
  const audit = await prisma.audit.findUnique({ where: { id: String(auditId) } });
  if (!audit) {
    reply.code(404).send({ ok: false, message: "Audit not found" });
    return null;
  }
  if (req.user?.role !== "admin" && audit.userId !== req.user?.sub) {
    reply.code(403).send({ ok: false, message: "Forbidden" });
    return null;
  }
  return audit;
}

app.get("/audits", { preHandler: app.requireAuth }, async (req, reply) => {
  const take = Math.min(Number(req.query?.take || 20), 100);
  const skip = Math.max(Number(req.query?.skip || 0), 0);

  const where = req.user.role === "admin" ? {} : { userId: req.user.sub };

  const audits = await prisma.audit.findMany({
    where,
    take,
    skip,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      createdAt: true,
      updatedAt: true,
      title: true,
      site: true,
      standard: true,
      auditor: true,
      sourceFile: true,
      userId: true,
    },
  });

  return reply.send({ ok: true, take, skip, audits });
});

app.get("/audits/:auditId", { preHandler: app.requireAuth }, async (req, reply) => {
  const { auditId } = req.params;
  const audit = await requireAuditOwner(req, reply, auditId);
  if (!audit) return;
  return reply.send({ ok: true, audit });
});

app.post("/audits", { preHandler: app.requireAuth }, async (req, reply) => {
  try {
    const body = req.body || {};
    const audit = await prisma.audit.create({
      data: {
        title: body.title ?? null,
        site: body.site ?? null,
        standard: body.standard ?? null,
        auditor: body.auditor ?? null,
        userId: req.user.sub,
      },
    });
    return reply.code(201).send({ ok: true, audit });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ ok: false, message: err?.message || "Failed to create audit" });
  }
});

// --------------------
// Media (kept because you already had it)
// --------------------
app.post("/audits/:auditId/media", { preHandler: app.requireAuth }, async (req, reply) => {
  try {
    const { auditId } = req.params;
    const kind = String(req.query?.kind || "file");

    const audit = await requireAuditOwner(req, reply, auditId);
    if (!audit) return;

    const part = await req.file();
    if (!part) return reply.code(400).send({ ok: false, message: "No file uploaded" });

    const originalName = safeFilename(part.filename || "upload.bin");
    const storageKey = makeStorageKey({ auditId, kind, originalName });
    const absPath = absPathForKey(storageKey);

    await ensureDir(path.dirname(absPath));
    await pipeline(part.file, fs.createWriteStream(absPath));

    const stat = fs.statSync(absPath);

    const media = await prisma.mediaFile.create({
      data: {
        auditId,
        kind,
        filename: originalName,
        mime: String(part.mimetype || "application/octet-stream"),
        sizeBytes: Number(stat.size),
        storageKey,
      },
    });

    return reply.code(201).send({ ok: true, auditId, ...media });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ ok: false, message: err?.message || "Failed to upload media" });
  }
});

// --------------------
// Findings routes
// --------------------
registerFindingsRoutes(app);

// --------------------
// Boot
// --------------------
await ensureDir(STORAGE_ROOT);

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log(`Storage root: ${STORAGE_ROOT}`);
  console.log(`Max upload bytes: ${MAX_UPLOAD_BYTES}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
