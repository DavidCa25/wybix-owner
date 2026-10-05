// SDK 54's fingerprint loader matches POSIX ignore patterns against Windows
// module paths. Normalize the paths before matching, keeping native hashing on.
const fs = require('node:fs');
const path = require('node:path');

if (process.platform === 'win32') {
  const manifest = require.resolve('@expo/fingerprint/package.json', {
    paths: [path.resolve(__dirname, '../apps/pos-mobile')],
  });
  const version = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
  if (version === '0.15.5') {
    const loader = path.join(path.dirname(manifest), 'build/ExpoConfigLoader.js');
    const original = '.map((modulePath) => path_1.default.relative(projectRoot, modulePath));';
    const normalized = '.map((modulePath) => (0, Path_1.toPosixPath)(path_1.default.relative(projectRoot, modulePath)));';
    const source = fs.readFileSync(loader, 'utf8');
    if (source.includes(original)) {
      fs.writeFileSync(loader, source.replace(original, normalized));
    } else if (!source.includes(normalized)) {
      throw new Error('Unexpected SDK 54 fingerprint loader; review the Windows patch.');
    }
  }
}
