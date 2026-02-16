// apps/api/server.js
// sc-audit-copilot API (Stage 3 ready)
// - Auth (register/login/me) with JWT
// - User-owned audits (userId set on create; list/get enforced)
// - Media upload/list/download (stream-to-disk)
// - Findings + Evidence (registered from src/routes/findings.routes.js)
// - Simple report builders (PDF/XLSX/DOCX template)

import Fastify from "fastify";
import multipart from "@fastify/multipart";
import jwt from "@fastify/jwt";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";

import PDFDocument from "pdfkit";
import * as XLSX from "xlsx";

import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";

import { registerFindingsRoutes } from "./src/routes/findings.routes.js";

// --------------------
// Config
// --------------------
const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || "127.0.0.1";
const DATABASE_URL = process.env.DATABASE_URL || "";
const JWT_SECRET = process.env.JWT_SECRET || "change-me-now";

// 5GB default if env missing
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 5 * 1024 * 1024 * 1024);

// NOTE: storage lives inside apps/api by default (process.cwd() = apps/api)
const STORAGE_ROOT = path.resolve(process.cwd(), "storage", "audits");
const TEMPLATE_PATH = path.resolve(process.cwd(), "templates", "audit-template.docx");

const prisma = new PrismaClient();
const app = Fastify({ logger: true });

// expose prisma for external route modules that expect app.prisma
app.decorate("prisma", prisma);

// --------------------
// Plugins
// --------------------
await app.register(multipart, {
  limits: {
    fileSize: MAX_UPLOAD_BYTES, // hard cap per uploaded file
  },
});

await app.register(jwt, {
  secret: JWT_SECRET,
});

// --------------------
// Auth helpers
// --------------------
app.decorate("requireAuth", async (req, reply) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return reply.code(401).send({ ok: false, message: "Missing Bearer token" });

    const payload = await req.jwtVerify();
    // payload shape = { sub, email, role, iat, ... }
    req.user = payload;
  } catch (err) {
    return reply.code(401).send({ ok: false, message: "Invalid token" });
  }
});

// --------------------
// Helpers: storage
// --------------------
async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function kindToSubdir(kind) {
  const k = (kind || "").toLowerCase();
  if (k === "image") return "images";
  if (k === "video") return "video";
  if (k === "audio") return "audio";
  return "uploads";
}

function safeFilename(name) {
  const base = (name || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
  return base.slice(0, 180);
}

function makeStorageKey({ auditId, kind, originalName }) {
  const ext = path.extname(originalName || "");
  const rand = crypto.randomBytes(8).toString("hex");
  const sub = kindToSubdir(kind);
  return path.join(auditId, "media", sub, `${Date.now()}_${rand}${ext}`);
}

function absPathForKey(storageKey) {
  return path.join(STORAGE_ROOT, storageKey);
}

// Prevent path traversal: ensure resolved path stays under base
function safeJoin(baseDir, storageKey) {
  const resolved = path.resolve(baseDir, storageKey);
  const baseResolved = path.resolve(baseDir);
  if (!resolved.startsWith(baseResolved + path.sep) && resolved !== baseResolved) {
    throw new Error("Unsafe path");
  }
  return resolved;
}

// --------------------
// Helpers: CSV parsing (small files only)
// --------------------
function parseCsvToRows(csvText) {
  const lines = csvText.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return { header: [], rows: [] };

  const parseLine = (line) => {
    const out = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
        continue;
      }
      if (ch === '"') {
        inQ = !inQ;
        continue;
      }
      if (ch === "," && !inQ) {
        out.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };

  const header = parseLine(lines[0]);
  const rows = lines.slice(1).map(parseLine).map((cols) => {
    const obj = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = cols[i] ?? "";
    return obj;
  });

  return { header, rows };
}

function normalizeStatus(s) {
  const v = String(s || "").trim().toUpperCase();
  if (v === "PASS" || v === "OK") return "PASS";
  if (v === "FAIL" || v === "NG") return "FAIL";
  if (v === "NA" || v === "N/A") return "NA";
  return v ? v : "UNKNOWN";
}

function computeSummary(items) {
  const summary = { total: items.length, pass: 0, fail: 0, na: 0, unknown: 0 };
  for (const it of items) {
    if (it.status === "PASS") summary.pass++;
    else if (it.status === "FAIL") summary.fail++;
    else if (it.status === "NA") summary.na++;
    else summary.unknown++;
  }
  return summary;
}

async function readSmallUploadToBuffer(file, maxBytes = 25 * 1024 * 1024) {
  // For CSV uploads / reports only. Not for video.
  const parts = [];
  let total = 0;
  for await (const chunk of file.file) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error(`Upload too large for report parsing (>${maxBytes} bytes)`);
    }
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

// --------------------
// Helpers: reports
// --------------------
function buildPdfBuffer({ title, summary, items }) {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const chunks = [];
  doc.on("data", (d) => chunks.push(d));
  return new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).text(title || "Audit Report", { align: "left" });
    doc.moveDown();

    doc.fontSize(12).text(`Total: ${summary.total}`);
    doc.text(`PASS: ${summary.pass}`);
    doc.text(`FAIL: ${summary.fail}`);
    doc.text(`N/A: ${summary.na}`);
    doc.text(`UNKNOWN: ${summary.unknown}`);
    doc.moveDown();

    doc.fontSize(12).text("Items:");
    doc.moveDown(0.5);

    for (const it of items) {
      doc.text(`${it.idx}. ${it.id} — ${it.status} — ${it.comment || ""}`);
    }

    doc.end();
  });
}

function buildXlsxBuffer({ sheetName, items }) {
  const wsData = [
    ["#", "Item", "Status", "Comment"],
    ...items.map((it) => [it.idx, it.id, it.status, it.comment || ""]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName || "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

// --------------------
// Helpers: DOCX template rendering
// --------------------
function renderDocxFromTemplate({ templatePath, data }) {
  const content = fs.readFileSync(templatePath, "binary");
  const zip = new PizZip(content);
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
  doc.render(data);
  return doc.getZip().generate({ type: "nodebuffer" });
}

function makeDocxData({ audit, summary, items }) {
  return {
    title: audit.title || "Audit Report",
    site: audit.site || "",
    standard: audit.standard || "",
    auditor: audit.auditor || "",
    generatedAt: new Date().toISOString(),
    total: summary.total,
    pass: summary.pass,
    fail: summary.fail,
    na: summary.na,
    unknown: summary.unknown,
    items: items.map((it) => ({
      idx: it.idx,
      id: it.id,
      status: it.status,
      comment: it.comment || "",
    })),
  };
}

// --------------------
// Helpers: ownership
// --------------------
async function requireAuditOwner(req, reply, auditId) {
  const audit = await prisma.audit.findUnique({ where: { id: auditId } });
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

// --------------------
// Routes: Health
// --------------------
app.get("/health", async () => ({
  ok: true,
  service: "sc-audit-copilot",
  status: "running",
  dbUrlLoaded: Boolean(DATABASE_URL),
  maxUploadBytes: MAX_UPLOAD_BYTES,
}));

// --------------------
// Routes: Auth
// --------------------

// POST /auth/register
app.post("/auth/register", async (req, reply) => {
  try {
    const { email, password, role } = req.body || {};
    const cleanEmail = String(email || "").trim().toLowerCase();
    const cleanRole = String(role || "auditor").trim();

    if (!cleanEmail || !password) {
      return reply.code(400).send({ ok: false, message: "email and password are required" });
    }

    const existing = await prisma.user.findUnique({ where: { email: cleanEmail } });
    if (existing) {
      return reply.code(409).send({ ok: false, message: "User already exists" });
    }

    const passwordHash = await bcrypt.hash(String(password), 10);

    const user = await prisma.user.create({
      data: {
        email: cleanEmail,
        passwordHash,
        role: cleanRole,
      },
      select: { id: true, email: true, role: true, createdAt: true },
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

    const token = await reply.jwtSign({
      sub: user.id,
      email: user.email,
      role: user.role,
    });

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

// GET /auth/me (protected)
app.get("/auth/me", { preHandler: app.requireAuth }, async (req, reply) => {
  return reply.send({ ok: true, user: req.user });
});

// --------------------
// Routes: Audits (protected + user-owned)
// --------------------

// List audits (mine unless admin)
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

// Get single audit (mine unless admin)
app.get("/audits/:auditId", { preHandler: app.requireAuth }, async (req, reply) => {
  const { auditId } = req.params;
  const audit = await requireAuditOwner(req, reply, auditId);
  if (!audit) return;
  return reply.send({ ok: true, audit });
});

// Create audit (owned)
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
// Routes: Media (protected + audit owner)
// --------------------

// POST /audits/:auditId/media?kind=image|video|audio|file
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

    // stream to disk
    const writeStream = fs.createWriteStream(absPath);
    await pipeline(part.file, writeStream);

    const stat = fs.statSync(absPath);

    const media = await prisma.mediaFile.create({
      data: {
        auditId,
        kind: String(kind || "file"),
        filename: originalName,
        mime: String(part.mimetype || "application/octet-stream"),
        sizeBytes: Number(stat.size),
        storageKey,
      },
    });

    return reply.code(201).send({
      ok: true,
      auditId,
      mediaId: media.id,
      ...media,
    });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ ok: false, message: err?.message || "Failed to upload media" });
  }
});

// GET /audits/:auditId/media
app.get("/audits/:auditId/media", { preHandler: app.requireAuth }, async (req, reply) => {
  try {
    const { auditId } = req.params;

    const audit = await requireAuditOwner(req, reply, auditId);
    if (!audit) return;

    const media = await prisma.mediaFile.findMany({
      where: { auditId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        createdAt: true,
        kind: true,
        filename: true,
        mime: true,
        sizeBytes: true,
        storageKey: true,
      },
    });

    return reply.send({ ok: true, auditId, media });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ ok: false, message: err?.message || "Failed to list media" });
  }
});

// GET /media/:mediaId/download (auth + owner check via audit)
app.get("/media/:mediaId/download", { preHandler: app.requireAuth }, async (req, reply) => {
  try {
    const { mediaId } = req.params;

    const media = await prisma.mediaFile.findUnique({
      where: { id: mediaId },
      select: {
        id: true,
        auditId: true,
        filename: true,
        mime: true,
        storageKey: true,
      },
    });

    if (!media) {
      return reply.code(404).send({
        statusCode: 404,
        error: "Not Found",
        message: "media not found",
      });
    }

    const audit = await requireAuditOwner(req, reply, media.auditId);
    if (!audit) return;

    const filePath = safeJoin(STORAGE_ROOT, media.storageKey);

    if (!fs.existsSync(filePath)) {
      return reply.code(404).send({
        statusCode: 404,
        error: "Not Found",
        message: "file missing on disk",
      });
    }

    const stat = fs.statSync(filePath);

    reply.header("Content-Type", media.mime || "application/octet-stream");
    reply.header("Content-Length", stat.size);
    reply.header("Content-Disposition", `attachment; filename="${media.filename || "download.bin"}"`);

    return reply.send(fs.createReadStream(filePath));
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({
      statusCode: 500,
      error: "Internal Server Error",
      message: err?.message || "Failed to download media",
    });
  }
});

// --------------------
// Routes: Report upload (CSV) + generate reports (optional but useful)
// --------------------

// POST /audits/:auditId/report/upload (CSV) -> saves reportJson + mappingJson stub
app.post("/audits/:auditId/report/upload", { preHandler: app.requireAuth }, async (req, reply) => {
  try {
    const { auditId } = req.params;

    const audit = await requireAuditOwner(req, reply, auditId);
    if (!audit) return;

    const part = await req.file();
    if (!part) return reply.code(400).send({ ok: false, message: "No file uploaded" });

    const buf = await readSmallUploadToBuffer(part, 25 * 1024 * 1024);
    const text = buf.toString("utf8");
    const { rows } = parseCsvToRows(text);

    const items = rows.map((r, idx) => ({
      idx: idx + 1,
      id: r.Item || r.item || r.ID || r.id || `Row${idx + 1}`,
      status: normalizeStatus(r.Status || r.status),
      comment: r.Comment || r.comment || "",
    }));

    const summary = computeSummary(items);

    const updated = await prisma.audit.update({
      where: { id: auditId },
      data: {
        reportJson: { summary, items },
      },
    });

    return reply.send({ ok: true, audit: updated, summary });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ ok: false, message: err?.message || "Failed to process report" });
  }
});

// GET /audits/:auditId/report.pdf
app.get("/audits/:auditId/report.pdf", { preHandler: app.requireAuth }, async (req, reply) => {
  const { auditId } = req.params;

  const audit = await requireAuditOwner(req, reply, auditId);
  if (!audit) return;

  const report = audit.reportJson || { summary: { total: 0, pass: 0, fail: 0, na: 0, unknown: 0 }, items: [] };
  const pdfBuf = await buildPdfBuffer({ title: audit.title || "Audit Report", summary: report.summary, items: report.items });

  reply.header("Content-Type", "application/pdf");
  reply.header("Content-Disposition", `attachment; filename="audit_${auditId}.pdf"`);
  return reply.send(pdfBuf);
});

// GET /audits/:auditId/report.xlsx
app.get("/audits/:auditId/report.xlsx", { preHandler: app.requireAuth }, async (req, reply) => {
  const { auditId } = req.params;

  const audit = await requireAuditOwner(req, reply, auditId);
  if (!audit) return;

  const report = audit.reportJson || { items: [] };
  const xlsxBuf = buildXlsxBuffer({ sheetName: "Audit", items: report.items || [] });

  reply.header(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  reply.header("Content-Disposition", `attachment; filename="audit_${auditId}.xlsx"`);
  return reply.send(xlsxBuf);
});

// GET /audits/:auditId/report.docx (uses templates/audit-template.docx if present)
app.get("/audits/:auditId/report.docx", { preHandler: app.requireAuth }, async (req, reply) => {
  const { auditId } = req.params;

  const audit = await requireAuditOwner(req, reply, auditId);
  if (!audit) return;

  if (!fs.existsSync(TEMPLATE_PATH)) {
    return reply.code(400).send({
      ok: false,
      message: `Missing DOCX template at ${TEMPLATE_PATH}`,
    });
  }

  const report = audit.reportJson || { summary: { total: 0, pass: 0, fail: 0, na: 0, unknown: 0 }, items: [] };
  const data = makeDocxData({ audit, summary: report.summary, items: report.items || [] });
  const docxBuf = renderDocxFromTemplate({ templatePath: TEMPLATE_PATH, data });

  reply.header(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
  reply.header("Content-Disposition", `attachment; filename="audit_${auditId}.docx"`);
  return reply.send(docxBuf);
});

// --------------------
// Findings + Evidence routes (already working in your Terminal 2 tests)
// --------------------
registerFindingsRoutes(app);

// --------------------
// Boot
// --------------------
app.listen({ port: PORT, host: HOST }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log(`Server running at ${address}`);
  console.log(`Storage root: ${STORAGE_ROOT}`);
  console.log(`Max upload bytes: ${MAX_UPLOAD_BYTES}`);
});
