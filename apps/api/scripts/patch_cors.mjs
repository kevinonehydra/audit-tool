import fs from "node:fs";

const file = new URL("../server.js", import.meta.url);
let s = fs.readFileSync(file, "utf8");

// 1) Ensure import exists
if (!s.includes('from "@fastify/cors"')) {
  // insert after first import line (safe)
  const firstImportEnd = s.indexOf("\n");
  s =
    s.slice(0, firstImportEnd + 1) +
    'import cors from "@fastify/cors";\n' +
    s.slice(firstImportEnd + 1);
}

// 2) If block already exists, stop (idempotent)
if (s.includes("const CORS_ORIGINS") && s.includes("await app.register(cors")) {
  console.log("OK: CORS already present in server.js (no changes).");
  process.exit(0);
}

// 3) CORS block to inject
const corsBlock = `
// --------------------
// CORS (dev now, Lovable later)
// --------------------
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

await app.register(cors, {
  origin: (origin, cb) => {
    // allow curl/server-to-server
    if (!origin) return cb(null, true);

    // dev fallback if env not set
    if (CORS_ORIGINS.length === 0) {
      const ok = /^http:\\/\\/localhost:\\d+$/.test(origin);
      return cb(null, ok);
    }

    return cb(null, CORS_ORIGINS.includes(origin));
  },
  credentials: true,
});
`;

// 4) Insert BEFORE first route (health or auth), so cors is in effect
const markers = [
  '\napp.get("/health"',
  "\napp.get('/health'",
  '\napp.post("/auth/',
  "\napp.post('/auth/",
  "\n// Routes",
];

let inserted = false;
for (const m of markers) {
  const idx = s.indexOf(m);
  if (idx !== -1) {
    s = s.slice(0, idx) + corsBlock + "\n" + s.slice(idx);
    inserted = true;
    break;
  }
}

if (!inserted) {
  // fallback: append near end (still works, but not ideal)
  s += "\n" + corsBlock + "\n";
}

fs.writeFileSync(file, s, "utf8");
console.log("OK: patched server.js with CORS (safe + idempotent).");
