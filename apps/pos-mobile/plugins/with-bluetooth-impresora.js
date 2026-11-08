/**
 * Permisos de Bluetooth para la impresora de tickets (módulo wybix-bluetooth).
 *
 *   Android 12+ (API 31+)  BLUETOOTH_CONNECT  listar emparejados y conectar.
 *                          BLUETOOTH_SCAN     solo para cancelar una búsqueda
 *                                             activa antes de conectar; marcado
 *                                             neverForLocation (no pide ubicación).
 *   Android 11 o menor     BLUETOOTH / BLUETOOTH_ADMIN (maxSdkVersion 30).
 *
 * Se pide en tiempo de ejecución desde lib/impresion.ts (permisoBluetooth).
 */
const { withAndroidManifest } = require('expo/config-plugins');

const PERMISOS = [
  { 'android:name': 'android.permission.BLUETOOTH', 'android:maxSdkVersion': '30' },
  { 'android:name': 'android.permission.BLUETOOTH_ADMIN', 'android:maxSdkVersion': '30' },
  { 'android:name': 'android.permission.BLUETOOTH_CONNECT' },
  { 'android:name': 'android.permission.BLUETOOTH_SCAN', 'android:usesPermissionFlags': 'neverForLocation' },
];

module.exports = function withBluetoothImpresora(config) {
  return withAndroidManifest(config, (c) => {
    const m = c.modResults.manifest;
    const lista = (m['uses-permission'] = m['uses-permission'] ?? []);
    for (const p of PERMISOS) {
      const i = lista.findIndex((x) => x.$?.['android:name'] === p['android:name']);
      if (i >= 0) lista[i] = { $: { ...lista[i].$, ...p } };
      else lista.push({ $: p });
    }
    // El hardware Bluetooth es opcional: la app también se instala sin él.
    const rasgos = (m['uses-feature'] = m['uses-feature'] ?? []);
    if (!rasgos.some((f) => f.$?.['android:name'] === 'android.hardware.bluetooth')) {
      rasgos.push({ $: { 'android:name': 'android.hardware.bluetooth', 'android:required': 'false' } });
    }
    return c;
  });
};
