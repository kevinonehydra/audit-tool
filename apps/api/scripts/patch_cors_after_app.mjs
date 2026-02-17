import fs from "node:fs";

const file = new URL("../server.js", import.meta.url);
let s = fs.readFileSync(file, "utf8");

// 1) Remove any existing cors import lines
s = s.replace(/^\s*import\s+cors\s+from\s+["']@fastify\/cors["'];\s*\n/gm, "");

// 2) Remove any existing CORS blocks (keep it conservative: remove whole register call)
s = s.replace(/^\s*const\s+CORS_ORIGINS[\s\S]*?^\s*\}\);\s*$/gm, "");
s = s.replace(/^\s*await\s+app\.register\(\s*cors\s*,[\s\S]*?^\s*\}\);\s*$/gm, "");

// 3) Ensure we have the cors import exactly once (add after first import line)
const firstImport = s.match(/^\s*import .*?;\s*$/m);
if (firstImport) {
  const idx = s.indexOf(firstImport[0]) + firstImport[0].length;
  s = s.slice(0, idx) + '\nimport cors from "@fastify/cors";\n' + s.slice(idx);
} else {
  s = 'import cors from "@fastify/cors";\n' + s;
}

// 4) Our one true CORS block (safe)
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

// 5) Insert immediately after app creation line: const app = fastify(...);
const appCreateRegex = /(^\s*const\s+app\s*=\s*(?:fastify|Fastify)\([\s\S]*?\);\s*$)/m;
const m = s.match(appCreateRegex);

if (!m) {
  console.error("ERROR: Could not find app creation line: const app = fastify(...);");
  process.exit(1);
}

const insertAt = s.indexOf(m[0]) + m[0].length;
s = s.slice(0, insertAt) + corsBlock + s.slice(insertAt);

fs.writeFileSync(file, s, "utf8");
console.log("OK: patched server.js with a single clean CORS registration.");
