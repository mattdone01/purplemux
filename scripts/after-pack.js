/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
const { Arch } = require('builder-util');
const { rebuildStandaloneNative } = require('./rebuild-standalone-native');

exports.default = async (context) => {
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const unpacked = path.join(resources, 'app.asar.unpacked');

  if (process.platform === 'darwin') {
    const appRoot = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    const contents = path.join(appRoot, 'Contents');
    const appExecutable = path.join(contents, 'MacOS', context.packager.appInfo.productFilename);
    const nodeExecutable = path.join(resources, 'purplemux-node');
    if (fs.existsSync(appExecutable)) {
      fs.copyFileSync(appExecutable, nodeExecutable);
      fs.chmodSync(nodeExecutable, 0o755);
      console.log('[after-pack] copied Electron node helper');
    }
  }

  if (!fs.existsSync(unpacked)) return;

  const standaloneRoot = path.join(unpacked, '.next', 'standalone');
  if (fs.existsSync(standaloneRoot)) {
    const arch = Arch[context.arch];
    if (!arch || arch === 'universal') {
      throw new Error(`[after-pack] unsupported Electron native rebuild architecture: ${arch ?? context.arch}`);
    }
    const electronVersion = context.packager.config.electronVersion || require('electron/package.json').version;
    const binary = await rebuildStandaloneNative({
      standaloneRoot,
      electronVersion,
      platform: context.electronPlatformName,
      arch,
    });
    console.log(`[after-pack] rebuilt standalone better-sqlite3 for ${context.electronPlatformName}-${arch}: ${binary}`);
  }

  const removeBrokenSymlinks = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          fs.statSync(full);
        } catch {
          fs.unlinkSync(full);
        }
      } else if (entry.isDirectory()) {
        removeBrokenSymlinks(full);
      }
    }
  };

  removeBrokenSymlinks(unpacked);
  console.log('[after-pack] removed broken symlinks from app.asar.unpacked');
};
