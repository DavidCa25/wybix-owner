// Metro en el monorepo (npm workspaces). Expo detecta la raíz del monorepo y
// la usa como raíz del servidor: así funciona el desarrollo (las URLs del
// bundle salen de ahí).
//
// El build RELEASE (Gradle local o EAS) corre `expo export:embed` y le pasa la
// entrada relativa a esta carpeta ("../../node_modules/expo-router/entry.js");
// Metro la resuelve desde la raíz del servidor y no la encuentra ("Unable to
// resolve module"). Solo para ese comando, la raíz del servidor es la app.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
if (process.argv.includes('export:embed')) {
  config.server = { ...config.server, unstable_serverRoot: __dirname };
}

module.exports = config;
