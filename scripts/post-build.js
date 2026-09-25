/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');

const electronMode = process.argv.includes('--electron');

const root = path.join(__dirname, '..');
const standalone = path.join(root, '.next', 'standalone');

if (!fs.existsSync(standalone)) {
  console.error('[post-build] .next/standalone not found — did next build run with output: "standalone"?');
  process.exit(1);
}

// Next.js standalone copies .env* files automatically — remove them
for (const f of fs.readdirSync(standalone)) {
  if (f.startsWith('.env')) {
    fs.rmSync(path.join(standalone, f));
    console.log(`[post-build] removed ${f} from standalone`);
  }
}

// Dev-only files occasionally picked up by NFT — strip them out
for (const f of ['CLAUDE.md', 'AGENTS.md']) {
  const p = path.join(standalone, f);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { force: true });
    console.log(`[post-build] removed ${f} from standalone`);
  }
}

const copies = [
  { src: path.join(root, 'public'), dest: path.join(standalone, 'public') },
  { src: path.join(root, '.next', 'static'), dest: path.join(standalone, '.next', 'static') },
];

for (const { src, dest } of copies) {
  if (!fs.existsSync(src)) {
    console.log(`[post-build] skip ${path.relative(root, src)} (not found)`);
    continue;
  }
  fs.cpSync(src, dest, { recursive: true });
  console.log(`[post-build] ${path.relative(root, src)} → ${path.relative(root, dest)}`);
}

// Turbopack generates hashed external symlinks like
//   .next/standalone/.next/node_modules/pino-28069d5257187539 -> ../../node_modules/pino
// npm pack strips symlinks, so replace each with a tiny shim package that
// re-exports the real one via require('<name>'). At runtime Node resolves
// '<name>' by walking up the directory tree — in web mode that lands at the
// consumer's top-level install, in electron mode at standalone/node_modules.
const turbopackExternals = path.join(standalone, '.next', 'node_modules');
if (fs.existsSync(turbopackExternals)) {
  let shimmed = 0;
  for (const entry of fs.readdirSync(turbopackExternals, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    const link = path.join(turbopackExternals, entry.name);
    const target = fs.readlinkSync(link);
    const realName = path.basename(target);
    fs.rmSync(link, { force: true });
    fs.mkdirSync(link);
    fs.writeFileSync(
      path.join(link, 'package.json'),
      JSON.stringify({ name: entry.name, main: 'index.js' }, null, 2),
    );
    fs.writeFileSync(
      path.join(link, 'index.js'),
      `module.exports = require('${realName}');\n`,
    );
    shimmed++;
  }
  if (shimmed > 0) {
    console.log(`[post-build] shimmed ${shimmed} Turbopack external symlinks`);
  }
}

if (!electronMode) {
  // Web mode ships purplemux via npm; the consumer's install already contains
  // every runtime dependency (next, react-dom, pino, node-pty, ...) thanks to
  // package.json#dependencies, so Node resolves them via the normal walk-up
  // from standalone/. Dropping standalone/node_modules reclaims ~30MB and
  // avoids shipping NFT-pruned packages whose missing files would only ever
  // mask the real copy one level up.
  const webStandaloneModules = path.join(standalone, 'node_modules');
  if (fs.existsSync(webStandaloneModules)) {
    fs.rmSync(webStandaloneModules, { recursive: true, force: true });
    console.log('[post-build] web mode — removed standalone/node_modules');
  }
  return;
}

console.log('[post-build] electron mode — completing node_modules');

// --- Complete incomplete node_modules in standalone ---
// Next.js NFT traces only referenced files, leaving packages partial.
// Replace them with full copies from source node_modules.

const standaloneModules = path.join(standalone, 'node_modules');
const sourceModules = path.join(root, 'node_modules');

const countFiles = (dir) => {
  let count = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) count += countFiles(full);
      else count++;
    }
  } catch { /* ignore */ }
  return count;
};

const completeModules = (baseStandalone, baseSource) => {
  if (!fs.existsSync(baseStandalone)) return;
  let completed = 0;

  for (const entry of fs.readdirSync(baseStandalone)) {
    const dst = path.join(baseStandalone, entry);
    const src = path.join(baseSource, entry);

    if (entry.startsWith('.') || !fs.statSync(dst).isDirectory()) continue;

    // Recurse into scoped packages (@scope/pkg)
    if (entry.startsWith('@')) {
      completeModules(dst, src);
      continue;
    }

    if (!fs.existsSync(src)) continue;

    const srcCount = countFiles(src);
    const dstCount = countFiles(dst);
    if (dstCount < srcCount) {
      fs.rmSync(dst, { recursive: true, force: true });
      fs.cpSync(src, dst, { recursive: true });
      completed++;
    }
  }

  if (completed > 0) {
    const rel = path.relative(standalone, baseStandalone);
    console.log(`[post-build] ${rel}: ${completed} packages completed`);
  }
};

completeModules(standaloneModules, sourceModules);

// --- Ensure dynamically loaded packages and their full dependency trees ---
// pino loads transports in worker threads, so NFT doesn't trace them.
// Copy each package + all transitive dependencies from source node_modules.
const ensureWithDeps = (pkgName, visited = new Set()) => {
  if (visited.has(pkgName)) return;
  visited.add(pkgName);

  const src = path.join(sourceModules, pkgName);
  const dst = path.join(standaloneModules, pkgName);
  if (!fs.existsSync(src)) return;

  if (!fs.existsSync(dst)) {
    fs.cpSync(src, dst, { recursive: true });
    console.log(`[post-build] added missing module: ${pkgName}`);
  }

  const pkgJsonPath = path.join(src, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return;
  const { dependencies = {} } = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
  for (const dep of Object.keys(dependencies)) {
    ensureWithDeps(dep, visited);
  }
};

const dynamicPackages = ['pino-roll', 'pino-pretty', 'better-sqlite3'];
const visited = new Set();
for (const pkg of dynamicPackages) {
  ensureWithDeps(pkg, visited);
}

console.log('[post-build] node_modules patching done');
