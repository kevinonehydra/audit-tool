import fs from "node:fs";

const file = new URL("../server.js", import.meta.url);
let s = fs.readFileSync(file, "utf8");

// 1) Ensure auditsRoutes import exists (uncomment if commented, or insert after findings import)
if (!s.includes('from "./src/routes/audits.routes.js"')) {
  s = s.replace(
    /(\nimport\s+\{\s*registerFindingsRoutes\s*\}\s+from\s+"\.\/src\/routes\/findings\.routes\.js";\s*\n)/,
    `$1import { auditsRoutes } from "./src/routes/audits.routes.js";\n`
  );
} else {
  // if it exists but commented
  s = s.replace(
    /^\s*\/\/\s*(import\s+\{\s*auditsRoutes\s*\}\s+from\s+"\.\/src\/routes\/audits\.routes\.js";)/m,
    "$1"
  );
}

// 2) Remove any previous locals block we may have partially inserted
s = s.replace(
  /\n\/\/ locals for modular routes[\s\S]*?\n\nauditsRoutes\(app\);\s*\n/g,
  "\nauditsRoutes(app);\n"
);

// 3) Ensure auditsRoutes(app); exists exactly once and is before registerFindingsRoutes(app);
if (!s.includes("auditsRoutes(app);")) {
  s = s.replace(
    /\n(registerFindingsRoutes\(app\);\s*\n)/,
    "\nauditsRoutes(app);\n$1"
  );
}
// de-dupe
s = s.replace(/(auditsRoutes\(app\);\s*\n){2,}/g, "auditsRoutes(app);\n");

// 4) Inject locals block immediately before auditsRoutes(app);
const localsBlock =
`\n// locals for modular routes
app.locals = app.locals || {};
app.locals.prisma = prisma;
app.locals.requireAuditOwner = requireAuditOwner;
app.locals.safeFilename = safeFilename;
app.locals.makeStorageKey = makeStorageKey;
app.locals.absPathForKey = absPathForKey;
app.locals.ensureDir = ensureDir;
app.locals.readSmallUploadToBuffer = readSmallUploadToBuffer;
app.locals.parseCsvToRows = parseCsvToRows;
app.locals.normalizeStatus = normalizeStatus;
app.locals.computeSummary = computeSummary;
app.locals.buildPdfBuffer = buildPdfBuffer;
app.locals.buildXlsxBuffer = buildXlsxBuffer;
app.locals.TEMPLATE_PATH = TEMPLATE_PATH;
app.locals.makeDocxData = makeDocxData;
app.locals.renderDocxFromTemplate = renderDocxFromTemplate;
app.locals.safeJoin = safeJoin;
app.locals.STORAGE_ROOT = STORAGE_ROOT;
\n`;

s = s.replace(/\nauditsRoutes\(app\);\s*\n/, `${localsBlock}auditsRoutes(app);\n`);

// 5) Write back
fs.writeFileSync(file, s, "utf8");
console.log("OK: patched server.js (locals + auditsRoutes wiring).");
