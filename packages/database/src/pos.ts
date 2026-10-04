/**
 * OPERACIÓN DEL POS MOBILE EN UN EVENT, SIN INTERNET.
 *
 * Regla de cada operación: UNA transacción que guarda el hecho de negocio,
 * sus movimientos, la proyección y su evento en el outbox. Si algo falla,
 * ROLLBACK completo: no existe una venta sin su evento ni un evento sin su
 * venta, ni una venta a medias.
 *
 * La nube no participa: decide la base local. El outbox lleva los hechos
 * cuando haya red (ver @wybix/sync).
 */
import {
  Dec, indexar, congelarLinea, cobrar, totalDe, folio as armarFolio, proyectarStock, efecto, efectivoEsperado,
  corte as calcularCorte, puede, corteCiego, uuidv7, ErrorVenta,
  type Catalogo, type CatalogoIndexado, type LineaCarrito, type Pago, type TipoMovimiento, type RolEvento, type Accion, type MovCaja,
} from '@wybix/domain';
import type { BaseLocal, Sql } from './adaptador.ts';

export const ESQUEMA_EVENTOS = 1;

export interface Persona {
  uuid: string; name: string; role: RolEvento;
  /** Fase 3: la autorizó la dueña a distancia. `uuid` es entonces el id de la aprobación (CONSUMIDA en la nube). */
  remota?: boolean;
}

/** Quién autorizó, como viaja en el evento. `remote` deja que la nube lo verifique contra la aprobación. */
function autorizo(aut: Persona | null | undefined) {
  return aut ? { uuid: aut.uuid, name: aut.name, ...(aut.remota ? { remote: true } : {}) } : null;
}
export interface Reloj { ahora(): Date; }

export class ErrorPos extends Error {
  code: string;
  constructor(code: string, mensaje: string) { super(mensaje); this.code = code; }
}

export interface Identidad {
  device_uuid: string;
  company_uuid: string;
  location_uuid: string;
  location_name: string;
  timezone: string;
  register: { uuid: string; code: string; name: string };
}

/** Fecha de negocio en la zona del evento (no UTC: una venta de las 19:00 en León es de HOY). */
export function fechaNegocio(d: Date, tz: string): string {
  try { return d.toLocaleDateString('sv-SE', { timeZone: tz }); }
  catch { return d.toISOString().slice(0, 10); }
}

async function kv(tx: Sql, k: string): Promise<string | null> {
  return (await tx.get<{ v: string }>('SELECT v FROM kv WHERE k = ?', [k]))?.v ?? null;
}
async function setKv(tx: Sql, k: string, v: string): Promise<void> {
  await tx.run('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', [k, v]);
}

/**
 * FECHA DE NEGOCIO (Fase 3).
 *  - El TURNO la fija al abrirse; todo lo del turno (ventas, movimientos, corte)
 *    la hereda, aunque cruce la medianoche.
 *  - Al abrir, se calcula con la hora del servidor de Wybix cuando se conoce:
 *    hora de la tablet + el desfase medido en la última sincronización (que se
 *    guarda, así que también vale sin red). Un reloj mal puesto ya no cambia
 *    la fecha de una venta.
 *  - `occurred_at` sigue siendo la hora cruda de la tablet: la nube la corrige
 *    con el desfase que ella mide; corregirla aquí la corregiría dos veces.
 */
export const KV_DESFASE = 'reloj_desfase';
export async function desfaseGuardado(db: Sql): Promise<{ ms: number; at: string } | null> {
  const v = await kv(db, KV_DESFASE);
  try { return v ? JSON.parse(v) : null; } catch { return null; }
}
export async function guardarDesfase(db: Sql, ms: number, at: Date = new Date()) {
  await db.run(`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, [KV_DESFASE, JSON.stringify({ ms: Math.round(ms), at: at.toISOString() })]);
}

export function crearPos(db: BaseLocal, reloj: Reloj = { ahora: () => new Date() }) {
  let cacheCatalogo: { version: number; ix: CatalogoIndexado } | null = null;

  async function identidad(tx: Sql = db): Promise<Identidad> {
    const raw = await kv(tx, 'identidad');
    if (!raw) throw new ErrorPos('SIN_ENROLAR', 'Esta tablet todavía no está enrolada en un evento.');
    return JSON.parse(raw);
  }

  async function catalogoActual(tx: Sql = db): Promise<CatalogoIndexado> {
    const v = Number(await kv(tx, 'catalog_version') ?? 0);
    if (!v) throw new ErrorPos('SIN_CATALOGO', 'Falta descargar el catálogo del evento.');
    if (cacheCatalogo?.version === v) return cacheCatalogo.ix;
    const row = await tx.get<{ payload: string }>('SELECT payload FROM catalog_versions WHERE version = ?', [v]);
    if (!row) throw new ErrorPos('SIN_CATALOGO', 'Falta descargar el catálogo del evento.');
    cacheCatalogo = { version: v, ix: indexar(JSON.parse(row.payload) as Catalogo) };
    return cacheCatalogo.ix;
  }

  /** Evento al outbox, en la MISMA transacción que el hecho. */
  async function emitir(tx: Sql, agg: string, aggUuid: string, tipo: string, payload: unknown): Promise<number> {
    const r = await tx.run(
      `INSERT INTO outbox (event_uuid, aggregate_type, aggregate_uuid, event_type, occurred_at, schema_version, payload, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
      [uuidv7(reloj.ahora().getTime()), agg, aggUuid, tipo, reloj.ahora().toISOString(), ESQUEMA_EVENTOS, JSON.stringify(payload)]);
    return r.lastInsertRowId;
  }

  async function auditar(tx: Sql, empleado: string | null, accion: string, resultado: string, detalle?: unknown) {
    await tx.run('INSERT INTO audit_local (at, employee_uuid, action, result, detail) VALUES (?, ?, ?, ?, ?)',
      [reloj.ahora().toISOString(), empleado, accion, resultado, detalle == null ? null : JSON.stringify(detalle)]);
  }

  async function moverInventario(tx: Sql, id: Identidad, m: { product_uuid: string; type: TipoMovimiento; quantity: string; ref_type?: string; ref_uuid?: string; employee?: string | null; authorized_by?: string | null; reason?: string | null }) {
    const uuid = uuidv7(reloj.ahora().getTime());
    await tx.run(
      `INSERT INTO inventory_movements (uuid, product_uuid, type, quantity, ref_type, ref_uuid, employee_uuid, authorized_by_uuid, reason, occurred_at, origin_device)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuid, m.product_uuid, m.type, m.quantity, m.ref_type ?? null, m.ref_uuid ?? null, m.employee ?? null, m.authorized_by ?? null, m.reason ?? null,
       reloj.ahora().toISOString(), id.device_uuid]);
    const actual = await tx.get<{ qty: string }>('SELECT qty FROM stock_projection WHERE product_uuid = ?', [m.product_uuid]);
    const nuevo = Dec.de(actual?.qty ?? '0').mas(efecto(m)).toString();
    await tx.run('INSERT INTO stock_projection (product_uuid, qty) VALUES (?, ?) ON CONFLICT (product_uuid) DO UPDATE SET qty = excluded.qty', [m.product_uuid, nuevo]);
    return { uuid, product_uuid: m.product_uuid, type: m.type, quantity: m.quantity };
  }

  /** Tablet dada de baja: conserva todo lo pendiente, pero ya no abre turnos ni vende. */
  async function exigirActiva(tx: Sql) {
    if ((await kv(tx, 'device_status')) === 'REVOKED') throw new ErrorPos('REVOCADA', 'Esta tablet fue dada de baja. Avisa al encargado.');
  }

  async function turnoAbierto(tx: Sql, registerUuid: string) {
    return tx.get<{ uuid: string; employee_uuid: string; opening_cash: string; business_date: string; opened_at: string }>(
      `SELECT uuid, employee_uuid, opening_cash, business_date, opened_at FROM shifts WHERE register_uuid = ? AND status = 'OPEN'`, [registerUuid]);
  }

  function exigir(p: Persona, accion: Accion, autorizador?: Persona | null): Persona | null {
    if (puede(p.role, accion)) return null;
    if (autorizador && autorizador.uuid !== p.uuid && puede(autorizador.role, accion)) return autorizador;
    throw new ErrorPos('SIN_PERMISO', 'Esta acción necesita la autorización de un encargado.');
  }

  async function moverManual(p: Persona, aut: Persona | null, tipo: 'WASTE' | 'ADJUSTMENT', producto: string, cantidad: string, razon: string) {
    if (tipo === 'WASTE' && !Dec.de(cantidad).esPositivo()) throw new ErrorPos('CANTIDAD', 'La cantidad debe ser mayor a cero.');
    return db.transaccion(async (tx) => {
      const id = await identidad(tx);
      const cat = await catalogoActual(tx);
      if (!cat.producto.has(producto)) throw new ErrorPos('PRODUCTO', 'Ese producto no está en el catálogo del evento.');
      const m = await moverInventario(tx, id, { product_uuid: producto, type: tipo, quantity: cantidad, ref_type: tipo, employee: p.uuid, authorized_by: aut?.uuid ?? null, reason: razon });
      await auditar(tx, p.uuid, tipo, 'OK', { producto, cantidad, autorizo: aut?.uuid ?? null });
      await emitir(tx, 'INVENTORY_MOVEMENT', m.uuid, 'INVENTORY_MOVEMENT_RECORDED', {
        movement: { ...m, reason: razon }, employee: { uuid: p.uuid, name: p.name },
        authorized_by: autorizo(aut), device: id.device_uuid,
      });
      return m;
    });
  }

  return {
    identidad,
    catalogoActual,

    /** Abre turno: sobrevive a cerrar la app y reiniciar la tablet (está en la base). */
    async abrirTurno(p: Persona, fondo: string, opciones: { versionMinimaOk?: boolean } = {}) {
      if (opciones.versionMinimaOk === false) throw new ErrorPos('VERSION_ANTIGUA', 'Actualiza Wybix POS Mobile para abrir un turno nuevo.');
      exigir(p, 'ABRIR_TURNO');
      const f = Dec.de(fondo).redondear(2);
      if (f.esNegativo()) throw new ErrorPos('FONDO', 'El fondo no puede ser negativo.');
      return db.transaccion(async (tx) => {
        await exigirActiva(tx);
        const id = await identidad(tx);
        // El estado del evento llega en el snapshot. Cerrado o conciliado: no se
        // abre turno nuevo (lo ya vendido sin red sí se acepta al sincronizar).
        const loc = JSON.parse((await kv(tx, 'location')) ?? '{}') as { event_status?: string | null };
        if (loc.event_status === 'CLOSED' || loc.event_status === 'RECONCILED') {
          throw new ErrorPos('EVENTO_CERRADO', 'El evento ya cerró: no se pueden abrir turnos nuevos.');
        }
        if (await turnoAbierto(tx, id.register.uuid)) throw new ErrorPos('TURNO_ABIERTO', 'Ya hay un turno abierto en esta caja.');
        const ahora = reloj.ahora();
        const uuid = uuidv7(ahora.getTime());
        const desfase = (await desfaseGuardado(tx))?.ms ?? 0;
        const fecha = fechaNegocio(new Date(ahora.getTime() + desfase), id.timezone);
        await tx.run(`INSERT INTO shifts (uuid, status, register_uuid, employee_uuid, business_date, opening_cash, opened_at)
                      VALUES (?, 'OPEN', ?, ?, ?, ?, ?)`, [uuid, id.register.uuid, p.uuid, fecha, f.fijo(2), ahora.toISOString()]);
        await tx.run(`INSERT INTO cash_movements (uuid, shift_uuid, type, amount, employee_uuid, occurred_at) VALUES (?, ?, 'OPENING', ?, ?, ?)`,
          [uuidv7(ahora.getTime()), uuid, f.fijo(2), p.uuid, ahora.toISOString()]);
        await emitir(tx, 'SHIFT', uuid, 'SHIFT_OPENED', {
          shift_uuid: uuid, status: 'OPEN', business_date: fecha, opened_at: ahora.toISOString(), opening_cash: f.fijo(2),
          register: id.register, opened_by: { uuid: p.uuid, name: p.name }, device: id.device_uuid,
        });
        return { shift_uuid: uuid, business_date: fecha };
      });
    },

    async turnoActual() {
      const id = await identidad();
      return turnoAbierto(db, id.register.uuid);
    },

    /**
     * VENTA COMPLETA EN UNA TRANSACCIÓN: venta, líneas (precio/costo/receta/
     * consumos congelados), pagos, inventario, caja, proyección y outbox.
     */
    async registrarVenta(p: Persona, carrito: LineaCarrito[], pagos: Pago[], extra: { factura?: boolean; sale_uuid?: string } = {}) {
      exigir(p, 'VENDER');
      if (!carrito.length) throw new ErrorVenta('VACIA', 'La venta no tiene productos.');
      return db.transaccion(async (tx) => {
        await exigirActiva(tx);
        const id = await identidad(tx);
        const turno = await turnoAbierto(tx, id.register.uuid);
        if (!turno) throw new ErrorPos('SIN_TURNO', 'Abre el turno antes de vender.');
        const cat = await catalogoActual(tx);
        const lineas = carrito.map((l, i) => congelarLinea(cat, l, i + 1));
        const total = totalDe(lineas);
        const c = cobrar(total, pagos);
        const ahora = reloj.ahora();
        // Con terminal, la venta ya tenía UUID (es la referencia del cobro).
        const uuid = extra.sale_uuid ?? uuidv7(ahora.getTime());
        const sec = Number(await kv(tx, `folio:${id.register.code}`) ?? 0) + 1;
        await setKv(tx, `folio:${id.register.code}`, String(sec));
        const fol = armarFolio(id.register.code, sec);
        // La venta es del día de SU turno (una venta de las 00:10 de un turno de anoche es de anoche).
        const fecha = turno.business_date;

        await tx.run(`INSERT INTO sales (uuid, folio, shift_uuid, employee_uuid, catalog_version, total, cash_net, change, status, business_date, occurred_at, invoice_requested)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?)`,
          [uuid, fol, turno.uuid, p.uuid, cat.version, c.total, c.efectivo_neto, c.cambio, fecha, ahora.toISOString(), extra.factura ? 1 : 0]);
        for (const l of lineas) {
          await tx.run(`INSERT INTO sale_lines (sale_uuid, line_no, product_uuid, product_name, quantity, unit_price, subtotal, unit_cost, inventory_mode, recipe_uuid, variant_option_uuid, scale, modifiers, consumos)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [uuid, l.line_no, l.product_uuid, l.product_name, l.quantity, l.unit_price, l.subtotal, l.unit_cost, l.inventory_mode,
             l.recipe_uuid, l.variant_option_uuid, l.scale, JSON.stringify(l.modifiers), JSON.stringify(l.consumos)]);
        }
        let seq = 0;
        for (const pg of c.pagos) {
          await tx.run('INSERT INTO payments (sale_uuid, seq, method, amount, received, change, reference) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [uuid, ++seq, pg.method, pg.amount, pg.received, pg.change, pg.reference]);
        }
        // Inventario: DIRECT se consume a sí mismo (SALE); lo de receta es CONSUMPTION.
        const movs = [];
        for (const l of lineas) {
          for (const x of l.consumos) {
            if (Dec.de(x.quantity).esCero()) continue;
            movs.push(await moverInventario(tx, id, {
              product_uuid: x.product_uuid, type: x.source === 'SALE' && x.product_uuid === l.product_uuid ? 'SALE' : 'CONSUMPTION',
              quantity: x.quantity, ref_type: 'SALE', ref_uuid: uuid, employee: p.uuid,
            }));
          }
        }
        // Caja: solo el efectivo neto entra al cajón.
        if (Dec.de(c.efectivo_neto).esPositivo()) {
          await tx.run(`INSERT INTO cash_movements (uuid, shift_uuid, type, amount, ref_uuid, employee_uuid, occurred_at) VALUES (?, ?, 'SALE_CASH', ?, ?, ?, ?)`,
            [uuidv7(ahora.getTime()), turno.uuid, c.efectivo_neto, uuid, p.uuid, ahora.toISOString()]);
        }
        const metodo = new Set(c.pagos.map((x) => x.method)).size > 1 ? 'MIXTO' : c.pagos[0].method;
        await emitir(tx, 'SALE', uuid, 'SALE_RECORDED', {
          sale_uuid: uuid, folio: fol, business_date: fecha, occurred_at: ahora.toISOString(), total: c.total, paid_amount: c.total,
          balance: '0.00', payment_method: metodo, refunded_total: '0.00', cash_net: c.efectivo_neto, change: c.cambio,
          catalog_version: cat.version, shift_uuid: turno.uuid, invoice_requested: !!extra.factura,
          register: id.register, user: { uuid: p.uuid, name: p.name },
          lines: lineas, payments: c.pagos, movements: movs,
        });
        await tx.run(`INSERT INTO print_jobs (sale_uuid, kind, status, created_at) VALUES (?, 'TICKET', 'PENDING', ?)`, [uuid, ahora.toISOString()]);
        return { sale_uuid: uuid, folio: fol, total: c.total, cambio: c.cambio, lineas, catalog_version: cat.version };
      });
    },

    /** Merma: solo con permiso (o autorización de un encargado). */
    async registrarMerma(p: Persona, producto: string, cantidad: string, razon: string, autorizador?: Persona | null) {
      const aut = exigir(p, 'MERMA', autorizador);
      if (!razon?.trim()) throw new ErrorPos('RAZON', 'Indica la razón de la merma.');
      return moverManual(p, aut, 'WASTE', producto, Dec.de(cantidad).redondear(2).fijo(2), razon.trim());
    },

    /** Ajuste: siempre un movimiento con signo; nunca "stock = X". */
    async registrarAjuste(p: Persona, producto: string, delta: string, razon: string, autorizador?: Persona | null) {
      const aut = exigir(p, 'AJUSTE', autorizador);
      if (!razon?.trim()) throw new ErrorPos('RAZON', 'Indica la razón del ajuste.');
      const d = Dec.de(delta).redondear(2);
      if (d.esCero()) throw new ErrorPos('CANTIDAD', 'El ajuste no puede ser cero.');
      return moverManual(p, aut, 'ADJUSTMENT', producto, d.fijo(2), razon.trim());
    },

    /** Retiro, egreso o entrada de efectivo en el turno abierto. */
    async movimientoCaja(p: Persona, tipo: 'CASH_IN' | 'CASH_OUT' | 'EXPENSE', monto: string, razon: string, autorizador?: Persona | null) {
      const aut = exigir(p, tipo === 'EXPENSE' ? 'EGRESO' : 'RETIRO', autorizador);
      const m = Dec.de(monto).redondear(2);
      if (!m.esPositivo()) throw new ErrorPos('MONTO', 'El monto debe ser mayor a cero.');
      return db.transaccion(async (tx) => {
        const id = await identidad(tx);
        const turno = await turnoAbierto(tx, id.register.uuid);
        if (!turno) throw new ErrorPos('SIN_TURNO', 'No hay turno abierto.');
        const ahora = reloj.ahora();
        const uuid = uuidv7(ahora.getTime());
        await tx.run(`INSERT INTO cash_movements (uuid, shift_uuid, type, amount, reason, employee_uuid, authorized_by_uuid, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [uuid, turno.uuid, tipo, m.fijo(2), razon, p.uuid, aut?.uuid ?? null, ahora.toISOString()]);
        await emitir(tx, 'CASH_MOVEMENT', uuid, 'CASH_MOVEMENT_RECORDED', {
          movement_uuid: uuid, type: tipo, amount: m.fijo(2), business_date: turno.business_date, occurred_at: ahora.toISOString(),
          note: razon, shift_uuid: turno.uuid, register: id.register, user: { uuid: p.uuid, name: p.name },
          authorized_by: autorizo(aut),
        });
        return { movement_uuid: uuid };
      });
    },

    /** Lo que el cajero ve del corte: a ciegas si su rol no ve el esperado. */
    async resumenTurno(p: Persona) {
      const id = await identidad();
      const turno = await turnoAbierto(db, id.register.uuid);
      if (!turno) return null;
      const movs = await db.all<MovCaja>('SELECT type, amount FROM cash_movements WHERE shift_uuid = ?', [turno.uuid]);
      const ventas = await db.get<{ n: number; total: string | null }>(`SELECT COUNT(*) AS n, NULL AS total FROM sales WHERE shift_uuid = ?`, [turno.uuid]);
      const totales = await db.all<{ total: string }>('SELECT total FROM sales WHERE shift_uuid = ?', [turno.uuid]);
      const porMetodo = await db.all<{ method: string; amount: string }>(
        'SELECT p.method, p.amount FROM payments p JOIN sales s ON s.uuid = p.sale_uuid WHERE s.shift_uuid = ?', [turno.uuid]);
      const metodos: Record<string, string> = {};
      for (const x of porMetodo) metodos[x.method] = Dec.de(metodos[x.method] ?? '0').mas(x.amount).fijo(2);
      const ciego = corteCiego(p.role);
      // A ciegas tampoco van los importes: con el efectivo vendido y el fondo
      // que la misma persona abrió, el esperado se saca con una suma.
      return {
        shift_uuid: turno.uuid, abierto_por: turno.employee_uuid, abierto_at: turno.opened_at, ciego,
        tickets: Number(ventas?.n ?? 0),
        ventas: ciego ? null : Dec.suma(totales.map((t) => t.total)).fijo(2),
        por_metodo: ciego ? {} : metodos,
        esperado: ciego ? null : efectivoEsperado(movs).fijo(2),
      };
    },

    /** CORTE: mismo concepto de turno de la Fase 1, con evento sincronizable. */
    async cerrarTurno(p: Persona, contado: string, autorizador?: Persona | null) {
      return db.transaccion(async (tx) => {
        const id = await identidad(tx);
        const turno = await turnoAbierto(tx, id.register.uuid);
        if (!turno) throw new ErrorPos('SIN_TURNO', 'No hay turno abierto.');
        let aut: Persona | null = null;
        if (turno.employee_uuid !== p.uuid) {
          aut = exigir(p, 'CERRAR_TURNO_AJENO', autorizador);
          await auditar(tx, p.uuid, 'CERRAR_TURNO_AJENO', 'OK', { turno: turno.uuid, autorizo: aut?.uuid ?? p.uuid });
        } else exigir(p, 'CERRAR_TURNO_PROPIO');
        const movs = await tx.all<MovCaja>('SELECT type, amount FROM cash_movements WHERE shift_uuid = ?', [turno.uuid]);
        const r = calcularCorte(movs, contado);
        const ciego = corteCiego(p.role);
        const ahora = reloj.ahora();
        await tx.run(`UPDATE shifts SET status = 'CLOSED', closed_at = ?, closed_by_uuid = ?, authorized_by_uuid = ?, expected = ?, counted = ?, difference = ?, blind = ?
                      WHERE uuid = ?`, [ahora.toISOString(), p.uuid, aut?.uuid ?? null, r.expected, r.counted, r.difference, ciego ? 1 : 0, turno.uuid]);
        const abrio = await tx.get<{ name: string }>('SELECT name FROM staff WHERE uuid = ?', [turno.employee_uuid]);
        await emitir(tx, 'SHIFT', turno.uuid, 'SHIFT_CLOSED', {
          shift_uuid: turno.uuid, status: 'CLOSED', business_date: turno.business_date, opened_at: turno.opened_at, closed_at: ahora.toISOString(),
          opening_cash: turno.opening_cash, cash_expected: r.expected, cash_counted: r.counted, difference: r.difference, blind_count: ciego,
          register: id.register, opened_by: { uuid: turno.employee_uuid, name: abrio?.name ?? null }, closed_by: { uuid: p.uuid, name: p.name },
          authorized_by: autorizo(aut), device: id.device_uuid,
        });
        // El cajero a ciegas no ve el esperado ni la diferencia en pantalla.
        return ciego ? { shift_uuid: turno.uuid, counted: r.counted, ciego } : { shift_uuid: turno.uuid, ...r, ciego };
      });
    },

    /**
     * Recibir mercancía (descargada en el snapshot o por QR verificado). Se
     * guarda lo RECIBIDO; si difiere de lo enviado, la diferencia queda.
     * Recibir dos veces la misma transferencia no suma dos veces.
     */
    async recibirTransferencia(p: Persona, transferUuid: string, recibidos: Record<string, string>, autorizador?: Persona | null) {
      const aut = exigir(p, 'RECIBIR_TRANSFERENCIA', autorizador);
      return db.transaccion(async (tx) => {
        const id = await identidad(tx);
        const t = await tx.get<{ status: string; kind: string; source: string; from_location_uuid: string | null }>('SELECT status, kind, source, from_location_uuid FROM transfers WHERE uuid = ?', [transferUuid]);
        if (!t || t.kind !== 'IN') throw new ErrorPos('TRANSFERENCIA', 'Esa transferencia no es para este evento.');
        if (t.status === 'RECEIVED') return { transfer_uuid: transferUuid, ya_recibida: true };
        const lineas = await tx.all<{ product_uuid: string; product_name: string | null; qty_sent: string }>('SELECT product_uuid, product_name, qty_sent FROM transfer_lines WHERE transfer_uuid = ?', [transferUuid]);
        const movs = [], salida = [];
        for (const l of lineas) {
          const rec = Dec.de(recibidos[l.product_uuid] ?? l.qty_sent).redondear(2);
          if (rec.esNegativo()) throw new ErrorPos('CANTIDAD', 'Lo recibido no puede ser negativo.');
          await tx.run('UPDATE transfer_lines SET qty_received = ? WHERE transfer_uuid = ? AND product_uuid = ?', [rec.fijo(2), transferUuid, l.product_uuid]);
          if (rec.esPositivo()) movs.push(await moverInventario(tx, id, { product_uuid: l.product_uuid, type: 'TRANSFER_IN', quantity: rec.fijo(2), ref_type: 'TRANSFER', ref_uuid: transferUuid, employee: p.uuid, authorized_by: aut?.uuid ?? null }));
          salida.push({ product_uuid: l.product_uuid, product_name: l.product_name, qty_sent: Dec.de(l.qty_sent).fijo(2), qty_received: rec.fijo(2), difference: Dec.de(l.qty_sent).menos(rec).fijo(2) });
        }
        await tx.run(`UPDATE transfers SET status = 'RECEIVED', received_at = ?, employee_uuid = ? WHERE uuid = ?`, [reloj.ahora().toISOString(), p.uuid, transferUuid]);
        await emitir(tx, 'TRANSFER', transferUuid, 'TRANSFER_RECEIVED', {
          transfer_uuid: transferUuid, source: t.source, from_location_uuid: t.from_location_uuid, lines: salida, movements: movs,
          received_by: { uuid: p.uuid, name: p.name }, authorized_by: autorizo(aut), device: id.device_uuid,
        });
        return { transfer_uuid: transferUuid, ya_recibida: false, lineas: salida };
      });
    },

    /** Regresar sobrante a la sucursal base: RETURN_TRANSFER_OUT. */
    async regresarSobrante(p: Persona, lineas: Array<{ product_uuid: string; quantity: string }>, autorizador?: Persona | null) {
      const aut = exigir(p, 'RETORNO', autorizador);
      return db.transaccion(async (tx) => {
        const id = await identidad(tx);
        const home = await kv(tx, 'home_location_uuid');
        const cat = await catalogoActual(tx);
        const ahora = reloj.ahora();
        const uuid = uuidv7(ahora.getTime());
        await tx.run(`INSERT INTO transfers (uuid, kind, status, source, from_location_uuid, to_location_uuid, employee_uuid, created_at) VALUES (?, 'RETURN_OUT', 'SENT', 'LOCAL', ?, ?, ?, ?)`,
          [uuid, id.location_uuid, home, p.uuid, ahora.toISOString()]);
        const movs = [], salida = [];
        for (const l of lineas) {
          const q = Dec.de(l.quantity).redondear(2);
          if (!q.esPositivo()) continue;
          const nombre = cat.producto.get(l.product_uuid)?.nombre ?? null;
          await tx.run('INSERT INTO transfer_lines (transfer_uuid, product_uuid, product_name, qty_sent) VALUES (?, ?, ?, ?)', [uuid, l.product_uuid, nombre, q.fijo(2)]);
          movs.push(await moverInventario(tx, id, { product_uuid: l.product_uuid, type: 'RETURN_TRANSFER_OUT', quantity: q.fijo(2), ref_type: 'TRANSFER', ref_uuid: uuid, employee: p.uuid, authorized_by: aut?.uuid ?? null }));
          salida.push({ product_uuid: l.product_uuid, product_name: nombre, qty_sent: q.fijo(2) });
        }
        if (!salida.length) throw new ErrorPos('VACIA', 'No hay nada que regresar.');
        await emitir(tx, 'TRANSFER', uuid, 'RETURN_SENT', {
          transfer_uuid: uuid, kind: 'RETURN', from_location_uuid: id.location_uuid, to_location_uuid: home, lines: salida, movements: movs,
          sent_by: { uuid: p.uuid, name: p.name }, authorized_by: autorizo(aut), device: id.device_uuid,
        });
        return { transfer_uuid: uuid, lineas: salida };
      });
    },

    // ------------------------------------------------------- IMPRESIÓN (Fase 3)
    // La impresión es un efecto posterior a la venta y NUNCA la toca: no crea
    // venta, no mueve inventario, no registra pagos, no emite eventos.

    /** El ticket reconstruido desde lo GUARDADO (no desde la pantalla). `copia` si ya se imprimió antes. */
    async datosTicket(saleUuid: string) {
      const s = await db.get<{ folio: string; total: string; change: string; occurred_at: string; employee_uuid: string }>(
        'SELECT folio, total, change, occurred_at, employee_uuid FROM sales WHERE uuid = ?', [saleUuid]);
      if (!s) throw new ErrorPos('VENTA', 'No existe esa venta en esta tablet.');
      const id = await identidad();
      const cajero = await db.get<{ name: string }>('SELECT name FROM staff WHERE uuid = ?', [s.employee_uuid]);
      const lineas = await db.all<{ quantity: string; product_name: string; subtotal: string }>(
        'SELECT quantity, product_name, subtotal FROM sale_lines WHERE sale_uuid = ? ORDER BY line_no', [saleUuid]);
      const pagos = await db.all<{ method: string; amount: string; received: string | null }>(
        'SELECT method, amount, received FROM payments WHERE sale_uuid = ? ORDER BY seq', [saleUuid]);
      const impreso = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM print_jobs WHERE sale_uuid = ? AND status = 'PRINTED'`, [saleUuid]);
      return {
        negocio: id.location_name, caja: id.register.code, folio: s.folio, occurred_at: s.occurred_at, cajero: cajero?.name ?? '',
        lineas: lineas.map((l) => ({ cantidad: Dec.de(l.quantity).toString(), nombre: l.product_name, subtotal: Dec.de(l.subtotal).redondear(2).fijo(2) })),
        total: s.total, cambio: s.change, pagos: pagos.map((p) => ({ metodo: p.method, monto: p.received ?? p.amount })),
        copia: Number(impreso?.n ?? 0) > 0,
      };
    },

    /** Resultado de imprimir el ticket de una venta recién hecha (su trabajo TICKET). */
    async resultadoImpresion(saleUuid: string, ok: boolean, error?: string | null) {
      await db.transaccion(async (tx) => {
        await tx.run(`UPDATE print_jobs SET status = ?, attempts = attempts + 1, last_error = ? WHERE sale_uuid = ? AND kind = 'TICKET'`,
          [ok ? 'PRINTED' : 'FAILED', ok ? null : (error ?? 'sin detalle').slice(0, 300), saleUuid]);
        if (ok) await tx.run('UPDATE sales SET printed = 1 WHERE uuid = ?', [saleUuid]);
      });
    },

    /** Tickets que no se pudieron imprimir (para reimprimirlos desde Estado). */
    async ticketsSinImprimir() {
      return db.all<{ sale_uuid: string; folio: string; total: string; occurred_at: string; attempts: number; last_error: string | null }>(
        `SELECT j.sale_uuid, s.folio, s.total, s.occurred_at, j.attempts, j.last_error FROM print_jobs j JOIN sales s ON s.uuid = j.sale_uuid
          WHERE j.kind = 'TICKET' AND j.status IN ('FAILED', 'PENDING') ORDER BY s.occurred_at DESC`);
    },

    /**
     * Reimprimir: quién, cuándo, en qué tablet y cómo salió. Si el ticket
     * nunca se había impreso, el trabajo original pasa a PRINTED (el cliente
     * recibe su ticket por primera vez); si ya se había impreso, es una COPIA.
     */
    async registrarReimpresion(p: Persona, saleUuid: string, ok: boolean, error?: string | null) {
      exigir(p, 'REIMPRIMIR');
      return db.transaccion(async (tx) => {
        const venta = await tx.get<{ folio: string }>('SELECT folio FROM sales WHERE uuid = ?', [saleUuid]);
        if (!venta) throw new ErrorPos('VENTA', 'No existe esa venta en esta tablet.');
        const original = await tx.get<{ status: string }>(`SELECT status FROM print_jobs WHERE sale_uuid = ? AND kind = 'TICKET'`, [saleUuid]);
        const copia = original?.status === 'PRINTED';
        const ahora = reloj.ahora().toISOString();
        await tx.run(`INSERT INTO print_jobs (sale_uuid, kind, status, attempts, last_error, created_at) VALUES (?, 'REPRINT', ?, 1, ?, ?)`,
          [saleUuid, ok ? 'PRINTED' : 'FAILED', ok ? null : (error ?? 'sin detalle').slice(0, 300), ahora]);
        if (ok && !copia) await tx.run(`UPDATE print_jobs SET status = 'PRINTED', attempts = attempts + 1, last_error = NULL WHERE sale_uuid = ? AND kind = 'TICKET'`, [saleUuid]);
        if (ok) await tx.run('UPDATE sales SET printed = 1 WHERE uuid = ?', [saleUuid]);
        const id = await identidad(tx);
        await auditar(tx, p.uuid, 'TICKET_REIMPRESO', ok ? 'OK' : 'FAILED',
          { venta: saleUuid, folio: venta.folio, copia, dispositivo: id.device_uuid, error: ok ? null : (error ?? null) });
        return { copia, ok };
      });
    },

    /** Cambiar la impresora es de encargado: un cajero necesita autorización. */
    async configurarImpresora(p: Persona, conf: { tipo: 'red' | 'sistema' | 'ninguna'; host?: string }, autorizador?: Persona | null) {
      const aut = exigir(p, 'CONFIGURAR_IMPRESORA', autorizador);
      if (conf.tipo === 'red' && !/^[A-Za-z0-9.-]{1,253}$/.test(conf.host ?? '')) throw new ErrorPos('IMPRESORA', 'Escribe la dirección IP de la impresora.');
      return db.transaccion(async (tx) => {
        await tx.run(`INSERT INTO kv (k, v) VALUES ('impresora', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`,
          [JSON.stringify(conf.tipo === 'red' ? { tipo: 'red', host: conf.host } : { tipo: conf.tipo })]);
        await auditar(tx, p.uuid, 'IMPRESORA_CONFIGURADA', 'OK', { tipo: conf.tipo, host: conf.host ?? null, autorizo: aut?.uuid ?? null });
      });
    },

    async stock(): Promise<Array<{ product_uuid: string; qty: string }>> {
      return db.all('SELECT product_uuid, qty FROM stock_projection ORDER BY product_uuid');
    },

    /** La proyección se puede tirar y reconstruir de los hechos locales. */
    async reconstruirProyecciones() {
      return db.transaccion(async (tx) => {
        const movs = await tx.all<{ product_uuid: string; type: TipoMovimiento; quantity: string }>('SELECT product_uuid, type, quantity FROM inventory_movements');
        await tx.run('DELETE FROM stock_projection');
        for (const [u, q] of proyectarStock(movs)) await tx.run('INSERT INTO stock_projection (product_uuid, qty) VALUES (?, ?)', [u, q.toString()]);
        return movs.length;
      });
    },

    auditar: (empleado: string | null, accion: string, resultado: string, detalle?: unknown) => db.transaccion((tx) => auditar(tx, empleado, accion, resultado, detalle)),
  };
}

export type PosLocal = ReturnType<typeof crearPos>;
