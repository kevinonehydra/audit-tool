import dotenv from "dotenv";
dotenv.config();

import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";

import bcrypt from "bcryptjs";
import PDFDocument from "pdfkit";
import XLSX from "xlsx";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";

import { PrismaClient } from "@prisma/client";
import { registerFindingsRoutes } from "./src/routes/findings.routes.js";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3001);

const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 5368709120); // 5GB default
const STORAGE_ROOT = path.resolve(process.cwd(), "storage/audits");
const TEMPLATE_PATH = path.resolve(process.cwd(), "storage/templates/audit-template.docx");

const prisma = new PrismaClient();

function safeFilename(name) {
  const s = String(name || "file.bin");
  return (
    s
      .replace(/[\/\\]+/g, "_")
      .replace(/[\x00-\x1F\x7F]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180) || "file.bin"
  );
}

function safeJoin(base, rel) {
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(base, rel);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
    throw new Error("Invalid path");
  }
  return resolved;
}

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

function makeStorageKey({ auditId, kind, originalName }) {
  const safeKind = String(kind || "file").toLowerCase();
  const safeName = safeFilename(originalName || "upload.bin");
  const stamp = Date.now();
  return `${auditId}/${safeKind}/${stamp}_${safeName}`;
}

function absPathForKey(storageKey) {
  return path.join(STORAGE_ROOT, storageKey);
}

async function readSmallUploadToBuffer(part, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of part.file) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("Upload too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Minimal CSV parser (commas + quotes) for simple audit CSV uploads
function parseCsvToRows(csvText) {
  const text = String(csvText || "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length === 0) return { headers: [], rows: [] };

  const parseLine = (line) => {
    const out = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
        continue;
      }
      if (ch === '"') {
        q = !q;
        continue;
      }
      if (ch === "," && !q) {
        out.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    out.push(cur);
    return out.map((s) => String(s ?? "").trim());
  };

  const headers = parseLine(lines[0]);
  const rows = lines.slice(1).map((l) => {
    const vals = parseLine(l);
    const obj = {};
    for (let i = 0; i < headers.length; i++) obj[headers[i]] = vals[i] ?? "";
    return obj;
  });

  return { headers, rows };
}

function normalizeStatus(s) {
  const v = String(s || "").trim().toLowerCase();
  if (["pass", "passed", "ok", "yes"].includes(v)) return "PASS";
  if (["fail", "failed", "no"].includes(v)) return "FAIL";
  if (["na", "n/a", "not applicable"].includes(v)) return "NA";
  if (!v) return "UNKNOWN";
  return v.toUpperCase();
}

function computeSummary(items) {
  const sum = { total: items.length, pass: 0, fail: 0, na: 0, unknown: 0 };
  for (const it of items) {
    const st = String(it.status || "UNKNOWN").toUpperCase();
    if (st === "PASS") sum.pass++;
    else if (st === "FAIL") sum.fail++;
    else if (st === "NA") sum.na++;
    else sum.unknown++;
  }
  return sum;
}

async function buildPdfBuffer({ title, summary, items }) {
  return await new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 40 });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));

      doc.fontSize(18).text(String(title || "Audit Report"));
      doc.moveDown(0.5);

      const s = summary || { total: 0, pass: 0, fail: 0, na: 0, unknown: 0 };
      doc.fontSize(12).text(
        `Total: ${s.total}   PASS: ${s.pass}   FAIL: ${s.fail}   NA: ${s.na}   UNKNOWN: ${s.unknown}`
      );
      doc.moveDown(1);

      doc.fontSize(12).text("Items:");
      doc.moveDown(0.5);

      (items || []).slice(0, 5000).forEach((it) => {
        doc.fontSize(10).text(`#${it.idx}  ${it.id}  [${it.status}]  ${it.comment || ""}`);
      });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

function buildXlsxBuffer({ sheetName, items }) {
  const rows = (items || []).map((it) => ({
    idx: it.idx,
    id: it.id,
    status: it.status,
    comment: it.comment,
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, String(sheetName || "Audit"));
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

function makeDocxData({ audit, summary, items }) {
  const s = summary || { total: 0, pass: 0, fail: 0, na: 0, unknown: 0 };
  return {
    title: audit?.title || "Audit Report",
    site: audit?.site || "",
    standard: audit?.standard || "",
    auditor: audit?.auditor || "",
    summary_total: s.total,
    summary_pass: s.pass,
    summary_fail: s.fail,
    summary_na: s.na,
    summary_unknown: s.unknown,
    items: (items || []).map((it) => ({
      idx: it.idx,
      id: it.id,
      status: it.status,
      comment: it.comment,
    })),
  };
}

function renderDocxFromTemplate({ templatePath, data }) {
  const content = fs.readFileSync(templatePath);
  const zip = new PizZip(content);
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
  doc.render(data);
  return doc.getZip().generate({ type: "nodebuffer" });
}

// Ownership gate (admin sees all; others only own audits)
async function requireAuditOwner(req, reply, auditId) {
  const id = String(auditId || "");
  if (!id) {
    reply.code(400).send({ ok: false, message: "auditId required" });
    return null;
  }

  const audit = await prisma.audit.findUnique({ where: { id } });
  if (!audit) {
    reply.code(404).send({ ok: false, message: "audit not found" });
    return null;
  }

  const isAdmin = req.user?.role === "admin";
  const isOwner = audit.userId === req.user?.sub;
  if (!isAdmin && !isOwner) {
    reply.code(403).send({ ok: false, message: "forbidden" });
    return null;
  }

  return audit;
}

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(jwt, { secret: process.env.JWT_SECRET || "dev-secret-change-me" });
await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES } });

// Auth guard
app.decorate("requireAuth", async (req, reply) => {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ ok: false, message: "Unauthorized" });
  }
});

// Health
app.get("/health", async () => ({
  ok: true,
  service: "sc-audit-copilot",
  status: "running",
  dbUrlLoaded: Boolean(process.env.DATABASE_URL),
  maxUploadBytes: MAX_UPLOAD_BYTES,
}));

// Auth
app.post("/auth/register", async (req, reply) => {
  try {
    const { email, password } = req.body || {};
    const cleanEmail = String(email || "").trim().toLowerCase();

    if (!cleanEmail || !password) {
      return reply.code(400).send({ ok: false, message: "email and password are required" });
    }

    const exists = await prisma.user.findUnique({ where: { email: cleanEmail } });
    if (exists) return reply.code(409).send({ ok: false, message: "User already exists" });

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

    const token = await reply.jwtSign({ sub: user.id, email: user.email, role: user.role });
    return reply.send({ ok: true, token, user: { id: user.id, email: user.email, role: user.role } });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ ok: false, message: err?.message || "Failed to login" });
  }
});

app.get("/auth/me", { preHandler: app.requireAuth }, async (req, reply) => {
  return reply.send({ ok: true, user: req.user });
});

// --------------------
// Routes: Audits (single source of truth — INLINE ONLY)
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
  const audit = await requireAuditOwner(req, reply, req.params.auditId);
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
        kind: String(kind || "file"),
        filename: originalName,
        mime: String(part.mimetype || "application/octet-stream"),
        sizeBytes: Number(stat.size),
        storageKey,
      },
    });

    return reply.code(201).send({ ok: true, auditId, media });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ ok: false, message: err?.message || "Failed to upload media" });
  }
});

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

app.get("/media/:mediaId/download", { preHandler: app.requireAuth }, async (req, reply) => {
  try {
    const { mediaId } = req.params;

    const media = await prisma.mediaFile.findUnique({
      where: { id: mediaId },
      select: { id: true, auditId: true, filename: true, mime: true, storageKey: true },
    });

    if (!media) return reply.code(404).send({ ok: false, message: "media not found" });

    const audit = await requireAuditOwner(req, reply, media.auditId);
    if (!audit) return;

    const filePath = safeJoin(STORAGE_ROOT, media.storageKey);
    if (!fs.existsSync(filePath)) return reply.code(404).send({ ok: false, message: "file missing on disk" });

    const stat = fs.statSync(filePath);
    reply.header("Content-Type", media.mime || "application/octet-stream");
    reply.header("Content-Length", stat.size);
    reply.header("Content-Disposition", `attachment; filename="${media.filename || "download.bin"}"`);
    return reply.send(fs.createReadStream(filePath));
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ ok: false, message: err?.message || "Failed to download media" });
  }
});

// --------------------
// Routes: Report upload + generate reports
// --------------------
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
      data: { reportJson: { summary, items } },
    });

    return reply.send({ ok: true, audit: updated, summary });
  } catch (err) {
    req.log?.error?.(err);
    return reply.code(500).send({ ok: false, message: err?.message || "Failed to process report" });
  }
});

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

app.get("/audits/:auditId/report.xlsx", { preHandler: app.requireAuth }, async (req, reply) => {
  const { auditId } = req.params;

  const audit = await requireAuditOwner(req, reply, auditId);
  if (!audit) return;

  const report = audit.reportJson || { items: [] };
  const xlsxBuf = buildXlsxBuffer({ sheetName: "Audit", items: report.items || [] });

  reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  reply.header("Content-Disposition", `attachment; filename="audit_${auditId}.xlsx"`);
  return reply.send(xlsxBuf);
});

app.get("/audits/:auditId/report.docx", { preHandler: app.requireAuth }, async (req, reply) => {
  const { auditId } = req.params;

  const audit = await requireAuditOwner(req, reply, auditId);
  if (!audit) return;

  if (!fs.existsSync(TEMPLATE_PATH)) {
    return reply.code(400).send({ ok: false, message: `Missing DOCX template at ${TEMPLATE_PATH}` });
  }

  const report = audit.reportJson || { summary: { total: 0, pass: 0, fail: 0, na: 0, unknown: 0 }, items: [] };
  const data = makeDocxData({ audit, summary: report.summary, items: report.items || [] });
  const docxBuf = renderDocxFromTemplate({ templatePath: TEMPLATE_PATH, data });

  reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  reply.header("Content-Disposition", `attachment; filename="audit_${auditId}.docx"`);
  return reply.send(docxBuf);
});

// Findings routes (keep your existing implementation)
registerFindingsRoutes(app);

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log(`Storage root: ${STORAGE_ROOT}`);
  console.log(`Max upload bytes: ${MAX_UPLOAD_BYTES}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
