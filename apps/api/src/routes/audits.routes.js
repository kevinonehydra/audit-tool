import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function auditsRoutes(app) {
  // List audits
  app.get("/audits", async (req, reply) => {
    const take = Number(req.query.take || 20);
    const skip = Number(req.query.skip || 0);

    const audits = await prisma.audit.findMany({
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
      },
    });

    return reply.send({ ok: true, take, skip, audits });
  });

  // Get one audit
  app.get("/audits/:auditId", async (req, reply) => {
    const { auditId } = req.params;

    const audit = await prisma.audit.findUnique({
      where: { id: auditId },
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
        title: true,
        site: true,
        standard: true,
        auditor: true,
        sourceFile: true,
        mappingJson: true,
        reportJson: true,
      },
    });

    if (!audit) return reply.code(404).send({ ok: false, error: "Audit not found", auditId });
    return reply.send({ ok: true, audit });
  });

  // Create audit
  app.post("/audits", async (req, reply) => {
    const body = req.body || {};
    const title = body.title || "Data Center Audit - Draft";
    const site = body.site || null;
    const standard = body.standard || "TBD";
    const auditor = body.auditor || null;

    const audit = await prisma.audit.create({
      data: { title, site, standard, auditor, sourceFile: null, mappingJson: null, reportJson: null },
      select: { id: true, createdAt: true, title: true, site: true, standard: true, auditor: true },
    });

    return reply.code(201).send({ ok: true, audit });
  });
}
