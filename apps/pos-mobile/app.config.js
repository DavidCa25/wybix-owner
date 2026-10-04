/**
 * Perfiles de Wybix POS Mobile.
 *   produccion (por omision)  solo HTTPS, backend de Wybix, canal OTA "production".
 *   desarrollo                permite HTTP SOLO para probar contra la nube local
 *                             desde el emulador (WYBIX_PERFIL=desarrollo).
 * El applicationId no cambia entre perfiles: com.wybix.posmobile.
 */
module.exports = ({ config }) => {
  const dev = process.env.WYBIX_PERFIL === 'desarrollo';
  return {
    ...config,
    name: dev ? 'Wybix POS (desarrollo)' : config.name,
    extra: {
      ...config.extra,
      wybix: {
        ...config.extra.wybix,
        backend: process.env.WYBIX_BACKEND || config.extra.wybix.backend,
        channel: process.env.WYBIX_CANAL || config.extra.wybix.channel,
        perfil: dev ? 'desarrollo' : 'produccion',
        ...(dev && process.env.WYBIX_ANON_KEY ? { anonKey: process.env.WYBIX_ANON_KEY } : {}),
      },
    },
    plugins: config.plugins.map((p) =>
      Array.isArray(p) && p[0] === 'expo-build-properties'
        ? ['expo-build-properties', { android: { usesCleartextTraffic: dev } }]
        : p),
  };
};
