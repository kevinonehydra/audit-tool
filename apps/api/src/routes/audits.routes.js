import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";

/**
 * This module ONLY registers the /audits routes.
 * It expects server.js to have already decorated:
 *  - app.requireAuth
 *  - helpers used below (requireAuditOwner, safeFilename, makeStorageKey, absPathForKey, ensureDir, readSmallUploadToBuffer, parseCsvToRows, normalizeStatus, computeSummary, buildPdfBuffer, buildXlsxBuffer, TEMPLATE_PATH, makeDocxData, renderDocxFromTemplate, safeJoin, STORAGE_ROOT)
 *  - prisma in scope via closure? (No.)
 *
 * Because server.js currently owns all helpers + prisma, we attach routes that call back into app.locals.
 * We therefore require server.js to set: app.locals = { prisma, ...helpers } before calling auditsRoutes(app).
 */

export function auditsRoutes(app) {
  const L = app.locals || {};
  const prisma = L.prisma;
  if (!prisma) throw new Error("auditsRoutes: app.locals.prisma is missing. Set app.locals.prisma in server.js before auditsRoutes(app).");

  const requireAuditOwner = L.requireAuditOwner;
  const safeFilename = L.safeFilename;
  const makeStorageKey = L.makeStorageKey;
  const absPathForKey = L.absPathForKey;
  const ensureDir = L.ensureDir;
  const readSmallUploadToBuffer = L.readSmallUploadToBuffer;
  const parseCsvToRows = L.parseCsvToRows;
  const normalizeStatus = L.normalizeStatus;
  const computeSummary = L.computeSummary;
  const buildPdfBuffer = L.buildPdfBuffer;
  const buildXlsxBuffer = L.buildXlsxBuffer;
  const TEMPLATE_PATH = L.TEMPLATE_PATH;
  const makeDocxData = L.makeDocxData;
  const renderDocxFromTemplate = L.renderDocxFromTemplate;
  const safeJoin = L.safeJoin;
  const STORAGE_ROOT = L.STORAGE_ROOT;

  // --------------------
  // Routes: Audits (protected + user-owned)
  // --------------------
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

      return reply.code(201).send({ ok: true, auditId, mediaId: media.id, ...media });
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

      if (!media) {
        return reply.code(404).send({ statusCode: 404, error: "Not Found", message: "media not found" });
      }

      const audit = await requireAuditOwner(req, reply, media.auditId);
      if (!audit) return;

      const filePath = safeJoin(STORAGE_ROOT, media.storageKey);

      if (!fs.existsSync(filePath)) {
        return reply.code(404).send({ statusCode: 404, error: "Not Found", message: "file missing on disk" });
      }

      const stat = fs.statSync(filePath);

      reply.header("Content-Type", media.mime || "application/octet-stream");
      reply.header("Content-Length", stat.size);
      reply.header("Content-Disposition", `attachment; filename="${media.filename || "download.bin"}"`);

      return reply.send(fs.createReadStream(filePath));
    } catch (err) {
      req.log?.error?.(err);
      return reply.code(500).send({ statusCode: 500, error: "Internal Server Error", message: err?.message || "Failed to download media" });
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

// =====================
// Evidence: list for an audit
// GET /audits/:id/evidence
// =====================
app.route({
  method: "GET",
  url: "/audits/:id/evidence",
  preHandler: app.requireAuth ? app.requireAuth : undefined,
  handler: async (req, reply) => {
    const prisma = app.locals?.prisma;
    if (!prisma) return reply.code(500).send({ message: "app.locals.prisma missing" });

    const auditId = String(req.params.id);

    // Try common table names; adjust if your Prisma model differs.
    // 1) evidence (preferred)
    // 2) auditEvidence (fallback)
    let evidence = null;

    if (prisma.evidence?.findMany) {
      evidence = await prisma.evidence.findMany({
        where: { auditId },
        orderBy: { createdAt: "desc" },
      });
    } else if (prisma.auditEvidence?.findMany) {
      evidence = await prisma.auditEvidence.findMany({
        where: { auditId },
        orderBy: { createdAt: "desc" },
      });
    } else {
      return reply.code(500).send({
        message: "No Prisma model found for evidence. Expected prisma.evidence or prisma.auditEvidence.",
      });
    }

    return reply.send({ ok: true, auditId, evidence });
  },
});

}
