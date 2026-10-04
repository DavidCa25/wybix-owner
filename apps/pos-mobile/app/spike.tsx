/**
 * SPIKE 2.1 · SQLCipher en Android real (development build).
 *
 * Usa una base APARTE (`spike.db`, su propia llave en SecureStore) para no
 * tocar la operación. Mide lo que pidió la fase: apertura, migraciones,
 * escritura de cientos/miles de ventas, lectura de catálogo, outbox, PIN
 * (scrypt) y que el archivo en disco NO sea legible sin la llave. Una segunda
 * ejecución (tras matar la app o reiniciar) comprueba que los datos siguen.
 *
 * Resultado: en pantalla y en logcat con la etiqueta [SPIKE] (JSON).
 */
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import { File, Paths } from 'expo-file-system';
import { getRandomBytes } from 'expo-crypto';
import { migrar, crearPos, aplicarSnapshot, guardarEnrolamiento, pendientes, identificar } from '@wybix/database';
import { baseCifrada } from '../lib/base';
import { CONFIG } from '../lib/config';
import { hashPinAsync, pinCoincide, usarMotorScrypt, motorScryptActual } from '@wybix/auth';
import { scryptNativo } from '../modules/wybix-scrypt';
import { Boton, Tarjeta, pos as t, tipo } from '@wybix/ui';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const ms = async <T,>(f: () => Promise<T>): Promise<[T, number]> => { const a = Date.now(); const r = await f(); return [r, Date.now() - a]; };

function snapshot(nProductos: number) {
  const products = Array.from({ length: nProductos }, (_, i) => ({ uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, nombre: `Producto ${i}`,
    price: '25.00', cost: '6.5000', inventory_mode: 'DIRECT' as const, sellable: true, active: true, modifier_groups: [] }));
  return {
    snapshot_version: 1, security_revision: 1, device: { id: 'spike', uuid: 'spike', status: 'ACTIVE' },
    company: { uuid: '11111111-1111-4111-8111-111111111111', nombre: 'Spike' },
    location: { uuid: '33333333-3333-4333-8333-333333333333', nombre: 'Spike', tipo: 'EVENT', timezone: 'America/Mexico_City', status: 'ACTIVE', home_location_uuid: null, starts_at: null, ends_at: null },
    register: { uuid: '44444444-4444-4444-8444-444444444444', code: 'S1', name: 'Spike' },
    catalog: { catalog_version: 1, products, recipes: [], modifier_groups: [] },
    staff: [{ uuid: 'cccccccc-0000-4000-8000-000000000001', name: 'spike', role: 'SUPERVISOR', pin_hash: 'x', pin_sal: 'y', pin_algo: 'scrypt:16384:8:1:32', active: true }],
    payment_methods: [], trusted_keys: [], transfers: [], releases: null,
  };
}

export default function Spike() {
  // Herramienta de medición: solo en el perfil de desarrollo, nunca en el APK de producción.
  if (CONFIG.perfil !== 'desarrollo') return <View style={{ flex: 1, backgroundColor: t.fondo }} />;
  return <SpikeDesarrollo />;
}

/*
 * P0-A · PIN. Compatibilidad (RFC 7914 y hashes generados por el POS de
 * Windows con crypto.scryptSync) y tiempos: motor nativo vs JavaScript, y un
 * identificar() completo desglosado. Son datos de PRUEBA, no de nadie.
 */
const RFC3 = '7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2d5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887';
const DEL_POS_WINDOWS = [
  { pin: '4821', sal: 'b0f4977d44c7e8afd68aac1cbc07cd2f', hash: 'e0b5ffbcbfd31eda6b3acd99852995923c71c81dedecd5413d242b2d1fe843ad' },
  { pin: '7305', sal: '69e79ddc5968a31f453bdeb2cdffd6b1', hash: '438357632c0bd8837107f71867f158843fa460983d5517bf386b360bd2a32a4c' },
  { pin: '19283746', sal: '80cde0ebb119fc00dafe43837af42967', hash: '68edfed9c1894b53f05b5f34a94032e28861adaa1cb4109293bd0c0aaf5c5ba6' },
];
const ALGO = 'scrypt:16384:8:1:32';
const mediana = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const ahoraMs = () => (globalThis.performance?.now?.() ?? Date.now());

async function medirPin(conJs: boolean): Promise<Record<string, unknown>> {
  const r: Record<string, unknown> = { motor: motorScryptActual(), nativo_disponible: !!scryptNativo };
  r.rfc7914_vector3 = (await hashPinAsync('pleaseletmein', 'SodiumChloride', 'scrypt:16384:8:1:64')) === RFC3;
  const compat = [];
  for (const w of DEL_POS_WINDOWS) {
    const persona = { pin_hash: w.hash, pin_sal: w.sal, pin_algo: ALGO, active: true };
    compat.push((await pinCoincide(w.pin, persona)) && !(await pinCoincide(w.pin === '4821' ? '4822' : '4821', persona)));
  }
  r.hashes_pos_windows = compat.every(Boolean) ? `${compat.length}/${compat.length}` : JSON.stringify(compat);
  const tiempos: number[] = [];
  for (let i = 0; i < 7; i++) { const a = ahoraMs(); await hashPinAsync('4821', DEL_POS_WINDOWS[0].sal, ALGO); tiempos.push(ahoraMs() - a); }
  r.scrypt_ms_mediana = Math.round(mediana(tiempos));
  r.scrypt_ms = tiempos.map(Math.round);
  if (conJs) {
    const motor = motorScryptActual();
    usarMotorScrypt(null);
    const a = ahoraMs(); await hashPinAsync('4821', DEL_POS_WINDOWS[0].sal, ALGO); r.scrypt_js_ms = Math.round(ahoraMs() - a);
    if (motor !== 'js' && scryptNativo) usarMotorScrypt((pw, s, N, rr, p, d) => scryptNativo!.scryptHex(pw, s, N, rr, p, d), motor);
  }
  return r;
}

function SpikeDesarrollo() {
  const [salida, setSalida] = useState<string[]>([]);
  const [corriendo, setCorriendo] = useState(false);
  const log = (l: string) => setSalida((s) => [...s, l]);

  const pin = async (conJs: boolean) => {
    setCorriendo(true); setSalida([]);
    let r: Record<string, unknown>;
    try { r = { ...(await medirPin(conJs)), ok: true }; } catch (e) { r = { ok: false, error: (e as Error).message }; }
    console.log('[SPIKE-PIN] ' + JSON.stringify(r));
    for (const [k, v] of Object.entries(r)) log(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    setCorriendo(false);
  };

  const correr = async (nVentas: number) => {
    setCorriendo(true); setSalida([]);
    const r: Record<string, unknown> = { nVentas };
    try {
      let k = await SecureStore.getItemAsync('wx_spike_key');
      r.llave_existente = !!k;
      if (!k) { k = hex(getRandomBytes(32)); await SecureStore.setItemAsync('wx_spike_key', k); }
      const [nat, tAbrir] = await ms(async () => { const d = await SQLite.openDatabaseAsync('spike.db'); await d.execAsync(`PRAGMA key = "x'${k}'"`); await d.getFirstAsync('SELECT count(*) FROM sqlite_master'); return d; });
      r.abrir_ms = tAbrir;
      r.cipher_version = (await nat.getFirstAsync<{ cipher_version: string }>('PRAGMA cipher_version'))?.cipher_version ?? null;
      // La MISMA base que la app (una conexión con llave y una cola): withExclusiveTransactionAsync
      // abre otra conexión sin la llave y falla con "file is not a database".
      const db = baseCifrada(nat);
      const [m, tMig] = await ms(() => migrar(db));
      r.migracion = m; r.migrar_ms = tMig;
      const previas = Number((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sales'))?.n ?? 0);
      r.ventas_previas = previas;
      if (!previas) {
        await guardarEnrolamiento(db, { device_uuid: 'spike', device_id: 'spike' });
        const [, tSnap] = await ms(() => aplicarSnapshot(db, snapshot(300) as never));
        r.snapshot_300_productos_ms = tSnap;
        await db.run(`INSERT INTO inventory_movements (uuid, product_uuid, type, quantity, occurred_at, origin_device) VALUES ('seed', '00000000-0000-4000-8000-000000000000', 'TRANSFER_IN', '1000000', 'x', 'spike')`);
      }
      const pos = crearPos(db);
      const persona = { uuid: 'cccccccc-0000-4000-8000-000000000001', name: 'spike', role: 'SUPERVISOR' as const };
      if (!(await pos.turnoActual())) await pos.abrirTurno(persona, '0');
      const [, tVentas] = await ms(async () => {
        for (let i = 0; i < nVentas; i++) {
          await pos.registrarVenta(persona, [{ product_uuid: `00000000-0000-4000-8000-${String(i % 300).padStart(12, '0')}`, quantity: 1 }], [{ method: 'EFECTIVO', amount: '25.00' }]);
        }
      });
      r.ventas_ms = tVentas; r.ms_por_venta = +(tVentas / Math.max(1, nVentas)).toFixed(2);
      const [cat, tCat] = await ms(async () => { const c = await pos.catalogoActual(); return c.producto.size; });
      r.catalogo_productos = cat; r.leer_catalogo_ms = tCat;
      const [pend, tPend] = await ms(() => pendientes(db, 500, '9999'));
      r.outbox_lote_500_ms = tPend; r.outbox_lote = pend.length;
      r.outbox_total = (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM outbox'))?.n;
      r.ventas_total = (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sales'))?.n;
      const [, tPin] = await ms(async () => hashPinAsync('4821', '0123456789abcdef0123456789abcdef'));
      r.pin_scrypt_ms = tPin;
      // identificar() completo con un hash real del personal de la base cifrada.
      const sal = '0123456789abcdef0123456789abcdef';
      await db.run(`UPDATE staff SET pin_hash = ?, pin_sal = ?, pin_algo = ? WHERE uuid = ?`, [await hashPinAsync('4821', sal, ALGO), sal, ALGO, persona.uuid]);
      await db.run(`DELETE FROM pin_attempts WHERE staff_uuid = ?`, [persona.uuid]);
      const etapas: unknown[] = [];
      for (let i = 0; i < 3; i++) await identificar(db, persona.uuid, '4821', new Date(), (m) => etapas.push(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Math.round(v as number)]))));
      r.identificar_ms = etapas;
      r.motor_pin = motorScryptActual();
      // ¿El archivo en disco se puede leer sin la llave? SQLite en claro empieza con "SQLite format 3".
      const archivo = new File(Paths.document, 'SQLite', 'spike.db');
      const cabecera = archivo.exists ? archivo.bytesSync().slice(0, 16) : new Uint8Array();
      r.archivo_bytes = archivo.exists ? archivo.size : null;
      r.cabecera_es_sqlite_en_claro = String.fromCharCode(...cabecera).startsWith('SQLite format 3');
      r.cabecera_hex = hex(cabecera);
      r.ok = true;
    } catch (e) { r.ok = false; r.error = (e as Error).message; }
    console.log('[SPIKE] ' + JSON.stringify(r));
    for (const [k, v] of Object.entries(r)) log(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    setCorriendo(false);
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12, backgroundColor: t.fondo }}>
      <Text style={tipo.titulo}>Spike SQLCipher</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Boton testID="spike-100" titulo="100 ventas" onPress={() => correr(100)} cargando={corriendo} estilo={{ flex: 1 }} />
        <Boton testID="spike-1000" titulo="1000 ventas" onPress={() => correr(1000)} cargando={corriendo} estilo={{ flex: 1 }} />
        <Boton testID="spike-pin" titulo="PIN" onPress={() => pin(false)} cargando={corriendo} estilo={{ flex: 1 }} />
        <Boton testID="spike-pin-js" titulo="PIN + JS" onPress={() => pin(true)} cargando={corriendo} estilo={{ flex: 1 }} />
      </View>
      <Tarjeta>{salida.map((l, i) => <Text key={i} style={[tipo.cuerpo, { fontVariant: ['tabular-nums'] }]}>{l}</Text>)}</Tarjeta>
    </ScrollView>
  );
}
