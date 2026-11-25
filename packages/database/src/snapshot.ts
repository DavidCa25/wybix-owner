/**
 * SNAPSHOT: lo que la tablet necesita para operar SIN Internet.
 *
 * Se aplica en una transacción y solo REEMPLAZA datos de referencia
 * (catálogo, personal, formas de pago, llaves de confianza, transferencias
 * pendientes). Nunca toca ventas, turnos ni movimientos: lo hecho, hecho está.
 *
 *   snapshot_version   cada entrega de la nube
 *   catalog_version    el catálogo de la sucursal base (solo sube; una venta
 *                      guardada conserva la versión con la que se vendió)
 *   security_revision  personal/PIN/roles (solo sube)
 *
 * Un snapshot de OTRA empresa o de OTRO evento se rechaza completo.
 */
import type { Catalogo } from '@wybix/domain';
import type { BaseLocal, Sql } from './adaptador.ts';
import { ErrorPos, type Identidad } from './pos.ts';
import { Dec } from '@wybix/domain';

export interface Snapshot {
  snapshot_version: number;
  security_revision: number;
  device: { id: string; uuid: string; status: string };
  company: { uuid: string; nombre: string };
  /** default_channel: canal de precios con el que empieza cada cuenta (null = Mostrador). */
  location: { uuid: string; nombre: string; tipo: string; timezone: string; status: string; event_status?: string | null; default_channel?: string | null;
              home_location_uuid: string | null; starts_at: string | null; ends_at: string | null };
  register: { uuid: string; code: string; name: string };
  /** null = sin catálogo, o (nube 2026-11-24) la tablet ya tiene esta versión. */
  catalog: (Catalogo & { catalog_version: number }) | null;
  /** Versión vigente aunque `catalog` venga null. */
  catalog_version?: number | null;
  /** true = la nube no mandó catálogo ni personal porque no cambiaron. */
  sin_cambios?: boolean;
  /**
   * 'SUCURSAL' (POS 0094): la tablet es una caja de la sucursal y su snapshot
   * viene del Local Host de la computadora principal. Ausente = evento (nube).
   */
  modo?: 'EVENTO' | 'SUCURSAL';
  /** Caja de sucursal: existencias de la base (reemplazan la proyección local). */
  stock?: Array<{ product_uuid: string; qty: string }>;
  /** null = la tablet ya tiene esta revisión de personal. */
  staff: null | Array<{ uuid: string; name: string; role: string; pin_hash: string; pin_sal: string; pin_algo: string; active: boolean }>;
  payment_methods: Array<{ code: string; label: string; enabled: boolean }>;
  trusted_keys: Array<{ key_id: string; public_key: string; location_uuid: string | null; label: string | null }>;
  transfers: Array<{ transfer_uuid: string; from_location_uuid: string; to_location_uuid: string; status: string;
                     lines: Array<{ product_uuid: string; product_name: string | null; qty_sent: string }> }>;
  releases?: { latest_version: string | null; min_supported_version: string | null } | null;
  /**
   * Marca del negocio. Ausente = nube anterior (no se toca lo guardado);
   * null = sin marca (Wybix). El logo solo viene si la tablet no tenía este hash.
   */
  brand?: { hash: string; color: string | null; logo_incluido: boolean; logo: string | null } | null;
}

/** Lo que la tablet guarda en kv 'marca'. */
export interface MarcaGuardada { hash: string; color: string | null; logo: string | null }

async function kv(tx: Sql, k: string) { return (await tx.get<{ v: string }>('SELECT v FROM kv WHERE k = ?', [k]))?.v ?? null; }
async function setKv(tx: Sql, k: string, v: string) {
  await tx.run('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', [k, v]);
}

export async function aplicarSnapshot(db: BaseLocal, s: Snapshot, ahora = () => new Date().toISOString()) {
  return db.transaccion(async (tx) => {
    const previa = await kv(tx, 'identidad');
    if (previa) {
      const id = JSON.parse(previa) as Identidad;
      if (id.company_uuid !== s.company.uuid || id.location_uuid !== s.location.uuid) {
        throw new ErrorPos('SNAPSHOT_AJENO', 'Este snapshot es de otra empresa u otro evento: no se aplica.');
      }
    }
    // Evento por la nube, o caja de sucursal por Local Host: el modo lo fija
    // el emparejamiento (kv 'modo') y el snapshot tiene que coincidir.
    const sucursal = (await kv(tx, 'modo')) === 'SUCURSAL';
    if (sucursal ? s.location.tipo !== 'BRANCH' : s.location.tipo !== 'EVENT') {
      throw new ErrorPos('NO_EVENT', sucursal ? 'Esta tablet es caja de sucursal: el snapshot no es de una sucursal.' : 'Wybix POS Mobile solo opera ubicaciones de tipo evento.');
    }
    const deviceUuid = (await kv(tx, 'device_uuid')) ?? s.device.uuid;
    const identidad: Identidad = {
      device_uuid: deviceUuid, company_uuid: s.company.uuid, location_uuid: s.location.uuid, location_name: s.location.nombre,
      timezone: s.location.timezone || 'America/Mexico_City', register: s.register,
    };
    await setKv(tx, 'identidad', JSON.stringify(identidad));
    await setKv(tx, 'company', JSON.stringify(s.company));
    await setKv(tx, 'location', JSON.stringify(s.location));
    await setKv(tx, 'home_location_uuid', s.location.home_location_uuid ?? '');
    await setKv(tx, 'snapshot_version', String(s.snapshot_version));
    await setKv(tx, 'snapshot_at', ahora());
    if (s.releases) await setKv(tx, 'releases', JSON.stringify(s.releases));
    if (s.brand === null) await tx.run(`DELETE FROM kv WHERE k = 'marca'`);
    else if (s.brand) {
      const previa = await kv(tx, 'marca');
      const anterior = previa ? JSON.parse(previa) as MarcaGuardada : null;
      // Sin logo incluido = la nube confirma que ya lo tenemos (mismo hash).
      const tenia = anterior?.hash === s.brand.hash;
      const logo = s.brand.logo_incluido ? s.brand.logo : (tenia ? anterior!.logo : null);
      // Si faltó el logo, no se guarda el hash: la próxima vez la nube lo vuelve a mandar.
      const marca: MarcaGuardada = { hash: s.brand.logo_incluido || tenia ? s.brand.hash : '', color: s.brand.color, logo };
      await setKv(tx, 'marca', JSON.stringify(marca));
    }

    const cambios = { catalogo: false, personal: false, transferencias: 0 };

    // Catálogo: solo sube. Las ventas ya hechas conservan su versión.
    const vActual = Number(await kv(tx, 'catalog_version') ?? 0);
    if (s.catalog && s.catalog.catalog_version > vActual) {
      await tx.run('INSERT OR IGNORE INTO catalog_versions (version, received_at, payload) VALUES (?, ?, ?)',
        [s.catalog.catalog_version, ahora(), JSON.stringify(s.catalog)]);
      await tx.run('DELETE FROM products');
      for (const p of s.catalog.products) {
        await tx.run(`INSERT INTO products (uuid, catalog_version, nombre, price, cost, inventory_mode, sellable, active, category_uuid)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [p.uuid, s.catalog.catalog_version, p.nombre, p.price, p.cost, p.inventory_mode, p.sellable ? 1 : 0, p.active ? 1 : 0, p.category_uuid ?? null]);
      }
      await setKv(tx, 'catalog_version', String(s.catalog.catalog_version));
      cambios.catalogo = true;
    }

    // Personal y PIN: solo sube. Los intentos fallidos locales se conservan.
    const rActual = Number(await kv(tx, 'security_revision') ?? 0);
    if (s.staff && s.security_revision >= rActual) {
      await tx.run('DELETE FROM staff');
      for (const e of s.staff) {
        await tx.run(`INSERT INTO staff (uuid, name, role, pin_hash, pin_sal, pin_algo, active, security_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [e.uuid, e.name, e.role, e.pin_hash, e.pin_sal, e.pin_algo, e.active ? 1 : 0, s.security_revision]);
      }
      await setKv(tx, 'security_revision', String(s.security_revision));
      cambios.personal = true;
    }

    await tx.run('DELETE FROM payment_methods');
    let i = 0;
    for (const m of s.payment_methods) await tx.run('INSERT INTO payment_methods (code, label, enabled, sort) VALUES (?, ?, ?, ?)', [m.code, m.label, m.enabled ? 1 : 0, i++]);
    await tx.run('DELETE FROM trusted_keys');
    for (const k of s.trusted_keys) await tx.run('INSERT INTO trusted_keys (key_id, public_key, location_uuid, label) VALUES (?, ?, ?, ?)', [k.key_id, k.public_key, k.location_uuid, k.label]);

    // Caja de sucursal: la existencia es la de la base. Lo vendido aquí que aún
    // no sube se descuenta encima (la base todavía no lo sabe).
    if (sucursal && Array.isArray(s.stock)) {
      const pendiente = new Map<string, Dec>();
      for (const f of await tx.all<{ payload: string }>(`SELECT payload FROM outbox WHERE status = 'PENDING' AND event_type = 'SALE_RECORDED'`)) {
        for (const m of (JSON.parse(f.payload)?.movements ?? []) as Array<{ product_uuid: string; quantity: string }>) {
          pendiente.set(m.product_uuid, (pendiente.get(m.product_uuid) ?? Dec.cero).mas(m.quantity));
        }
      }
      await tx.run('DELETE FROM stock_projection');
      for (const x of s.stock) {
        const q = Dec.de(x.qty).menos(pendiente.get(x.product_uuid) ?? Dec.cero);
        await tx.run('INSERT INTO stock_projection (product_uuid, qty) VALUES (?, ?)', [x.product_uuid, q.toString()]);
      }
    }

    // Transferencias para este evento: se agregan si no existen (nunca se pisa una recibida).
    for (const t of s.transfers) {
      if (t.to_location_uuid !== s.location.uuid) continue;
      if (await tx.get('SELECT 1 FROM transfers WHERE uuid = ?', [t.transfer_uuid])) continue;
      await tx.run(`INSERT INTO transfers (uuid, kind, status, source, from_location_uuid, to_location_uuid, created_at) VALUES (?, 'IN', 'PENDING', 'SNAPSHOT', ?, ?, ?)`,
        [t.transfer_uuid, t.from_location_uuid, t.to_location_uuid, ahora()]);
      for (const l of t.lines) {
        await tx.run('INSERT INTO transfer_lines (transfer_uuid, product_uuid, product_name, qty_sent) VALUES (?, ?, ?, ?)', [t.transfer_uuid, l.product_uuid, l.product_name, l.qty_sent]);
      }
      cambios.transferencias++;
    }
    return cambios;
  });
}

/**
 * Primer enrolamiento: identidad mínima antes del primer snapshot.
 * `modo` SUCURSAL (POS 0094): caja de la sucursal por Local Host, con su
 * dirección en la red del local. Sin modo: evento por la nube.
 */
export async function guardarEnrolamiento(db: BaseLocal, d: { device_uuid: string; device_id: string; modo?: 'EVENTO' | 'SUCURSAL'; local_host?: string | null }) {
  await db.transaccion(async (tx) => {
    await setKv(tx, 'device_uuid', d.device_uuid);
    await setKv(tx, 'device_id', d.device_id);
    await setKv(tx, 'modo', d.modo ?? 'EVENTO');
    if (d.local_host) await setKv(tx, 'local_host', d.local_host);
  });
}

/** Cómo está emparejada esta tablet: evento (nube) o caja de sucursal (Local Host). */
export async function modoDeOperacion(db: BaseLocal): Promise<{ modo: 'EVENTO' | 'SUCURSAL'; local_host: string | null }> {
  const m = await kv(db as unknown as Sql, 'modo');
  return { modo: m === 'SUCURSAL' ? 'SUCURSAL' : 'EVENTO', local_host: await kv(db as unknown as Sql, 'local_host') };
}

/**
 * Transferencia recibida por QR (ya VERIFICADA por @wybix/sync con una llave
 * de confianza del snapshot). Se registra como pendiente de confirmar.
 */
export async function importarTransferencia(db: BaseLocal, m: { transfer_uuid: string; company_uuid: string; from_location_uuid: string; to_location_uuid: string;
  lines: Array<{ product_uuid: string; qty_sent: string }> }, firma: string, ahora = () => new Date().toISOString()) {
  return db.transaccion(async (tx) => {
    const id = JSON.parse((await kv(tx, 'identidad')) ?? 'null') as Identidad | null;
    if (!id) throw new ErrorPos('SIN_ENROLAR', 'La tablet no está enrolada.');
    if (m.company_uuid !== id.company_uuid || m.to_location_uuid !== id.location_uuid) {
      throw new ErrorPos('TRANSFERENCIA_AJENA', 'Esa transferencia es para otra empresa u otro evento.');
    }
    if (await tx.get('SELECT 1 FROM transfers WHERE uuid = ?', [m.transfer_uuid])) return { nueva: false };
    const nombres = new Map((await tx.all<{ uuid: string; nombre: string }>('SELECT uuid, nombre FROM products')).map((p) => [p.uuid, p.nombre]));
    for (const l of m.lines) if (!nombres.has(l.product_uuid)) throw new ErrorPos('PRODUCTO', 'La transferencia trae un producto que no está en el catálogo del evento.');
    await tx.run(`INSERT INTO transfers (uuid, kind, status, source, from_location_uuid, to_location_uuid, manifest, signature, created_at) VALUES (?, 'IN', 'PENDING', 'QR', ?, ?, ?, ?, ?)`,
      [m.transfer_uuid, m.from_location_uuid, m.to_location_uuid, JSON.stringify(m), firma, ahora()]);
    for (const l of m.lines) await tx.run('INSERT INTO transfer_lines (transfer_uuid, product_uuid, product_name, qty_sent) VALUES (?, ?, ?, ?)', [m.transfer_uuid, l.product_uuid, nombres.get(l.product_uuid) ?? null, l.qty_sent]);
    return { nueva: true };
  });
}
