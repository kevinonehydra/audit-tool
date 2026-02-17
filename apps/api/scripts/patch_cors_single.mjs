import fs from "node:fs";

const file = new URL("../server.js", import.meta.url);
let s = fs.readFileSync(file, "utf8");

// 1) Remove ALL existing cors imports (we'll add exactly one back)
s = s.replace(/^\s*import\s+cors\s+from\s+["']@fastify\/cors["'];\s*\n/gm, "");

// 2) Remove any previous CORS blocks we added (CORS_ORIGINS + register(cors...))
//    This is intentionally broad to delete duplicates safely.
s = s.replace(/\/\/\s*-{10,}\s*\n\/\/\s*CORS[\s\S]*?await\s+app\.register\(\s*cors\s*,[\s\S]*?\);\s*\n/gm, "");

// 3) Also remove any other app.register(cors, ...) calls (in case you had an older one)
s = s.replace(/^\s*await\s+app\.register\(\s*cors\s*,[\s\S]*?\);\s*\n/gm, "");

// 4) Add single import near top (after first import line if possible)
const firstImportMatch = s.match(/^\s*import .*?;\s*$/m);
if (firstImportMatch) {
  const idx = s.indexOf(firstImportMatch[0]) + firstImportMatch[0].length;
  s = s.slice(0, idx) + "\nimport cors from \"@fastify/cors\";\n" + s.slice(idx);
} else {
  s = "import cors from \"@fastify/cors\";\n" + s;
}

// 5) The one true CORS block
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

// 6) Insert BEFORE first route so CORS applies to everything
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
  s += "\n" + corsBlock + "\n";
}

fs.writeFileSync(file, s, "utf8");
console.log("OK: server.js now has exactly one CORS import + one CORS registration.");
