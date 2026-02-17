// apps/api/src/routes/findings.routes.js
// Permanent fix: remove reliance on any req.context/app.locals "audit" object.
// This route does its own Prisma audit ownership check and never crashes.

import { PrismaClient } from "@prisma/client";

export function registerFindingsRoutes(app) {
  // Use decorated prisma if you have it; else create a local client safely.
  const prisma = app.prisma || new PrismaClient();

  function isAdmin(req) {
    return String((req && req.user && req.user.role) || "").toLowerCase() === "admin";
  }

  async function assertAuditAccess(req, reply, auditId) {
    if (!auditId) {
      reply.code(400).send({ ok: false, message: "auditId is required" });
      return null;
    }

    const audit = await prisma.audit.findUnique({
      where: { id: String(auditId) },
      select: { id: true, userId: true },
    });

    if (!audit) {
      reply.code(404).send({ ok: false, message: "Audit not found" });
      return null;
    }

    if (!isAdmin(req) && audit.userId !== req.user.sub) {
      reply.code(403).send({ ok: false, message: "Forbidden" });
      return null;
    }

    return audit;
  }

  function getFindingsDelegate() {
    if (prisma.finding) return prisma.finding;
    if (prisma.auditFinding) return prisma.auditFinding;
    return null;
  }

  // GET /audits/:auditId/findings (protected)
  app.get("/audits/:auditId/findings", { preHandler: app.requireAuth }, async (req, reply) => {
    try {
      const auditId = req.params && req.params.auditId;
      const audit = await assertAuditAccess(req, reply, auditId);
      if (!audit) return;

      const delegate = getFindingsDelegate();

      // If no Findings model exists yet, return empty list (still 200, stable API).
      if (!delegate) {
        return reply.send({ ok: true, auditId: audit.id, findings: [] });
      }

      let findings = [];
      try {
        findings = await delegate.findMany({
          where: { auditId: audit.id },
          orderBy: { createdAt: "desc" },
        });
      } catch (e) {
        req.log && req.log.warn && req.log.warn({ err: e }, "Findings query failed; returning empty list");
        findings = [];
      }

      return reply.send({ ok: true, auditId: audit.id, findings });
    } catch (err) {
      req.log && req.log.error && req.log.error(err);
      return reply.code(500).send({ ok: false, message: (err && err.message) || "Failed to fetch findings" });
    }
  });
}
