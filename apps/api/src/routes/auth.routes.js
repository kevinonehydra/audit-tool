// apps/api/src/routes/auth.routes.js
import bcrypt from "bcryptjs";

export function registerAuthRoutes(app) {
  // POST /auth/register
  app.post("/auth/register", async (req, reply) => {
    try {
      const { email, password, role } = req.body || {};
      if (!email || !password) {
        return reply.code(400).send({ ok: false, message: "email and password are required" });
      }

      const normalizedEmail = String(email).trim().toLowerCase();
      const passwordHash = await bcrypt.hash(String(password), 10);

      const user = await app.prisma.user.create({
        data: {
          email: normalizedEmail,
          passwordHash,
          role: role ? String(role) : "auditor",
        },
        select: { id: true, email: true, role: true, createdAt: true },
      });

      return reply.code(201).send({ ok: true, user });
    } catch (err) {
      const msg = err?.message || "Failed to register";
      if (msg.toLowerCase().includes("unique")) {
        return reply.code(409).send({ ok: false, message: "email already exists" });
      }
      req.log?.error?.(err);
      return reply.code(500).send({ ok: false, message: msg });
    }
  });

  // POST /auth/login
  app.post("/auth/login", async (req, reply) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) {
        return reply.code(400).send({ ok: false, message: "email and password are required" });
      }

      const normalizedEmail = String(email).trim().toLowerCase();

      const user = await app.prisma.user.findUnique({
        where: { email: normalizedEmail },
      });

      if (!user) return reply.code(401).send({ ok: false, message: "invalid credentials" });

      const ok = await bcrypt.compare(String(password), user.passwordHash);
      if (!ok) return reply.code(401).send({ ok: false, message: "invalid credentials" });

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
}
