/**
 * Findings + Evidence routes (Stage 3)
 * - All routes are protected by JWT (requireAuth)
 * - Findings belong to Audit
 * - Evidence links Finding <-> MediaFile (must belong to same audit)
 */
export function registerFindingsRoutes(app) {
  // Helper: enforce auth + ownership (admin can bypass ownership)
  async function assertAuditAccess(req, reply, auditId) {
    // must be authenticated
    if (!req.user) {
      reply.code(401).send({ ok: false, message: "Missing Bearer token" });
      return null;
    }

    const audit = await app.prisma.audit.findUnique({ where: { id: auditId } });
    if (!audit) {
      reply.code(404).send({ ok: false, message: "Audit not found" });
      return null;
    }

    const isAdmin = req.user?.role === "admin";
    const ownerId = audit.userId;

    // If audit has an owner, enforce ownership unless admin
    if (!isAdmin && ownerId && ownerId !== req.user.sub) {
      reply.code(403).send({ ok: false, message: "Forbidden" });
      return null;
    }

    return audit;
  }

  // -------------------------
  // GET /audits/:auditId/findings (PROTECTED)
  // -------------------------
  app.get(
    "/audits/:auditId/findings",
    { preHandler: app.requireAuth },
    async (req, reply) => {
      try {
        const { auditId } = req.params;

        const audit = await assertAuditAccess(req, reply, auditId);
        if (!audit) return;

        const findings = await app.prisma.finding.findMany({
          where: { auditId },
          orderBy: { createdAt: "desc" },
          include: {
            evidence: {
              orderBy: { createdAt: "desc" },
              include: { media: true },
            },
          },
        });

        return reply.send({ ok: true, auditId, findings });
      } catch (err) {
        req.log?.error?.(err);
        return reply
          .code(500)
          .send({ ok: false, message: err?.message || "Failed to list findings" });
      }
    }
  );

  // -------------------------
  // POST /audits/:auditId/findings (PROTECTED)
  // -------------------------
  app.post(
    "/audits/:auditId/findings",
    { preHandler: app.requireAuth },
    async (req, reply) => {
      try {
        const { auditId } = req.params;
        const body = req.body || {};

        const audit = await assertAuditAccess(req, reply, auditId);
        if (!audit) return;

        if (!body.title || typeof body.title !== "string") {
          return reply.code(400).send({ ok: false, message: "title is required" });
        }

        const finding = await app.prisma.finding.create({
          data: {
            auditId,
            title: body.title,
            description: body.description ?? null,
            severity: body.severity ?? "medium",
            area: body.area ?? null,
            clauseRef: body.clauseRef ?? null,
          },
          include: { evidence: { include: { media: true } } },
        });

        return reply.code(201).send({ ok: true, auditId, finding });
      } catch (err) {
        req.log?.error?.(err);
        return reply
          .code(500)
          .send({ ok: false, message: err?.message || "Failed to create finding" });
      }
    }
  );

  // -------------------------
  // POST /findings/:findingId/evidence (PROTECTED)
  // body: { mediaId, note? }
  // -------------------------
  app.post(
    "/findings/:findingId/evidence",
    { preHandler: app.requireAuth },
    async (req, reply) => {
      try {
        const { findingId } = req.params;
        const body = req.body || {};

        if (!body.mediaId || typeof body.mediaId !== "string") {
          return reply.code(400).send({ ok: false, message: "mediaId is required" });
        }

        const finding = await app.prisma.finding.findUnique({
          where: { id: findingId },
          include: { audit: true },
        });

        if (!finding) {
          return reply.code(404).send({ ok: false, message: "Finding not found" });
        }

        // Enforce access on the audit that owns the finding
        const audit = await assertAuditAccess(req, reply, finding.auditId);
        if (!audit) return;

        const media = await app.prisma.mediaFile.findUnique({
          where: { id: body.mediaId },
        });

        if (!media) {
          return reply.code(404).send({ ok: false, message: "Media not found" });
        }

        if (media.auditId !== finding.auditId) {
          return reply.code(400).send({
            ok: false,
            message: "Media must belong to the same audit as the finding",
          });
        }

        const evidence = await app.prisma.findingEvidence.create({
          data: {
            findingId,
            mediaId: body.mediaId,
            note: body.note ?? null,
          },
          include: { media: true },
        });

        return reply.code(201).send({ ok: true, findingId, evidence });
      } catch (err) {
        // unique constraint (findingId, mediaId) gives a Prisma error; return clean message
        const msg = err?.message || "Failed to attach evidence";
        req.log?.error?.(err);
        return reply.code(500).send({ ok: false, message: msg });
      }
    }
  );
}
