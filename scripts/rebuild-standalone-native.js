/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
const { rebuild } = require('@electron/rebuild');

const findNativeBinary = (directory) => {
  if (!fs.existsSync(directory)) return null;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === 'better_sqlite3.node') return full;
    if (entry.isDirectory()) {
      const nested = findNativeBinary(full);
      if (nested) return nested;
    }
  }
  return null;
};

const rebuildStandaloneNative = async ({ standaloneRoot, electronVersion, platform, arch }) => {
  const packageJson = path.join(standaloneRoot, 'package.json');
  const moduleRoot = path.join(standaloneRoot, 'node_modules', 'better-sqlite3');
  if (!fs.existsSync(packageJson) || !fs.existsSync(moduleRoot)) {
    throw new Error(`standalone better-sqlite3 is incomplete at ${standaloneRoot}`);
  }
  await rebuild({
    buildPath: standaloneRoot,
    electronVersion,
    platform,
    arch,
    onlyModules: ['better-sqlite3'],
    force: true,
    mode: 'sequential',
  });
  const binary = findNativeBinary(moduleRoot);
  if (!binary) throw new Error(`better-sqlite3 native binary missing after Electron rebuild at ${moduleRoot}`);
  return binary;
};

module.exports = { rebuildStandaloneNative };

if (require.main === module) {
  const [standaloneRoot, electronVersion, platform = process.platform, arch = process.arch] = process.argv.slice(2);
  if (!standaloneRoot || !electronVersion) {
    console.error('usage: node scripts/rebuild-standalone-native.js STANDALONE_ROOT ELECTRON_VERSION [PLATFORM] [ARCH]');
    process.exit(2);
  }
  rebuildStandaloneNative({ standaloneRoot: path.resolve(standaloneRoot), electronVersion, platform, arch })
    .then((binary) => console.log(`[native-rebuild] ${platform}-${arch}: ${binary}`))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
