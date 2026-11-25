// ============================================================================
//  COMANDOS DE LICENCIA. Cada uno llama a una función del licenciamiento v2
//  (20260926120000) o de la migración del panel (20261122120000). Todas
//  dejan su evento en license_events con `ctx.firma` como autor.
// ============================================================================
import { comando, llamar } from './nucleo.ts';
import { booleano, entero, giro, lista, motivo, objeto, opcional, pago, texto, uno, uuid, type Infer } from './validar.ts';

const objetivo = (i: { id: string }) => `licencia:${i.id}`;
const porMotivo = (i: { reason: string }) => i.reason;

/** Pago del panel -> `p_purchase` de las funciones de licencia (con descuento explicado). */
function compra(p: Infer<typeof pago> | null, reason: string, extra: Record<string, unknown> = {}) {
  if (!p) return { discount_reason: reason, ...extra };
  return {
    provider: p.provider,
    ref: p.ref,
    price_paid: p.provider === 'COURTESY' ? 0 : p.amount,
    discount_reason: reason,
    ...extra,
  };
}

export const licencias = [
  comando({
    nombre: 'licencia.emitir', tipo: 'cambio', rol: 'OPERATOR',
    entrada: objeto({
      edition: uno('EDITION_MONO', 'EDITION_MULTI'),
      vertical: giro,
      origin: uno('PRODUCTION', 'INTERNAL', 'QA', 'TEST'),
      support: opcional(uno('BASIC', 'PRIORITY')),
      payment: pago,
      customer: objeto({
        name: opcional(texto({ max: 120 })),
        email: opcional(texto({ max: 160, patron: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ })),
        phone: opcional(texto({ max: 30 })),
        business: opcional(texto({ max: 120 })),
      }),
      reason: motivo,
    }),
    motivo: porMotivo,
    ejecutar: (i, ctx) => llamar(ctx, 'license_issue_manual', { p_order: { ...i, support: i.support ?? 'BASIC', actor: ctx.firma } }),
  }),
  comando({
    nombre: 'licencia.estado', tipo: 'cambio', rol: 'OPERATOR',
    entrada: objeto({ id: uuid, status: uno('activa', 'suspendida', 'cancelada'), reason: motivo }),
    objetivo, motivo: porMotivo,
    ejecutar: (i, ctx) => llamar(ctx, 'license_set_status', { p_license: i.id, p_status: i.status, p_reason: i.reason, p_actor: ctx.firma }),
  }),
  comando({
    nombre: 'licencia.origen', tipo: 'cambio', rol: 'OPERATOR',
    entrada: objeto({ id: uuid, origin: uno('PRODUCTION', 'INTERNAL', 'QA', 'TEST'), reason: motivo }),
    objetivo, motivo: porMotivo,
    ejecutar: (i, ctx) => llamar(ctx, 'license_set_origin', { p_license: i.id, p_origin: i.origin, p_reason: i.reason, p_actor: ctx.firma }),
  }),
  comando({
    nombre: 'licencia.titular', tipo: 'cambio', rol: 'OPERATOR',
    entrada: objeto({
      id: uuid,
      customer: objeto({
        name: opcional(texto({ max: 120 })),
        email: opcional(texto({ max: 160, patron: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ })),
        phone: opcional(texto({ max: 30 })),
        business: opcional(texto({ max: 120 })),
      }),
      reason: motivo,
    }),
    objetivo, motivo: porMotivo,
    ejecutar: (i, ctx) => llamar(ctx, 'license_update_customer', { p_license: i.id, p_customer: i.customer, p_reason: i.reason, p_actor: ctx.firma }),
  }),
  comando({
    nombre: 'licencia.liberar_equipo', tipo: 'cambio', rol: 'OPERATOR',
    entrada: objeto({ id: uuid, machine_id: texto({ min: 8, max: 128 }), reason: motivo }),
    objetivo, motivo: porMotivo,
    ejecutar: (i, ctx) => llamar(ctx, 'license_release', { p_license_id: i.id, p_machine_id: i.machine_id, p_actor: ctx.firma }),
  }),
  comando({
    nombre: 'licencia.renovar', tipo: 'cambio', rol: 'OPERATOR',
    entrada: objeto({ id: uuid, kind: uno('MONTHLY', 'ANNUAL', 'MANUAL'), days: opcional(entero(1, 730)), payment: opcional(pago), reason: motivo }),
    objetivo, motivo: porMotivo,
    ejecutar: (i, ctx) => llamar(ctx, 'license_renew', {
      p_license: i.id, p_kind: i.kind, p_purchase: compra(i.payment, i.reason, i.kind === 'MANUAL' ? { days: i.days ?? 30 } : {}), p_actor: ctx.firma,
    }),
  }),
  comando({
    nombre: 'licencia.multi', tipo: 'cambio', rol: 'OPERATOR',
    entrada: objeto({ id: uuid, payment: opcional(pago), reason: motivo }),
    objetivo, motivo: porMotivo,
    ejecutar: (i, ctx) => llamar(ctx, 'license_upgrade_to_multi', { p_license: i.id, p_purchase: compra(i.payment, i.reason), p_actor: ctx.firma }),
  }),
  comando({
    nombre: 'licencia.mono', tipo: 'cambio', rol: 'OPERATOR',
    entrada: objeto({ id: uuid, reason: motivo }),
    objetivo, motivo: porMotivo,
    ejecutar: (i, ctx) => llamar(ctx, 'license_downgrade_to_mono', { p_license: i.id, p_reason: i.reason, p_actor: ctx.firma }),
  }),
  comando({
    nombre: 'licencia.giro_agregar', tipo: 'cambio', rol: 'OPERATOR',
    entrada: objeto({ id: uuid, vertical: giro, payment: opcional(pago), reason: motivo }),
    objetivo, motivo: porMotivo,
    ejecutar: (i, ctx) => llamar(ctx, 'license_add_vertical', { p_license: i.id, p_vertical: i.vertical, p_purchase: compra(i.payment, i.reason), p_actor: ctx.firma }),
  }),
  comando({
    nombre: 'licencia.giro_quitar', tipo: 'cambio', rol: 'OPERATOR',
    entrada: objeto({ id: uuid, vertical: giro, reason: motivo }),
    objetivo, motivo: porMotivo,
    ejecutar: (i, ctx) => llamar(ctx, 'license_remove_vertical', { p_license: i.id, p_vertical: i.vertical, p_actor: ctx.firma }),
  }),
  comando({
    nombre: 'licencia.pantallas', tipo: 'cambio', rol: 'OPERATOR',
    entrada: objeto({ id: uuid, vertical: giro, tier: uno('BASE', 'EXTENDED', 'UNLIMITED'), payment: opcional(pago), reason: motivo }),
    objetivo, motivo: porMotivo,
    ejecutar: (i, ctx) => llamar(ctx, 'license_set_screen_tier', {
      p_license: i.id, p_vertical: i.vertical, p_tier: i.tier, p_purchase: compra(i.payment, i.reason), p_actor: ctx.firma,
    }),
  }),
  comando({
    nombre: 'licencia.addon', tipo: 'cambio', rol: 'OPERATOR',
    entrada: objeto({ id: uuid, addon: uno('MULTIBRANCH'), enabled: booleano, reason: motivo }),
    objetivo, motivo: porMotivo,
    ejecutar: (i, ctx) => llamar(ctx, 'license_set_addon', { p_license: i.id, p_addon: i.addon, p_enabled: i.enabled, p_reason: i.reason, p_actor: ctx.firma }),
  }),
  comando({
    nombre: 'licencia.qa', tipo: 'cambio', rol: 'OPERATOR',
    entrada: objeto({
      id: uuid,
      grants: objeto({
        verticals: opcional(lista(giro, 3)),
        screen_tier: opcional(uno('BASE', 'EXTENDED', 'UNLIMITED')),
        edition: opcional(uno('mono', 'multi')),
        paid_until: opcional(texto({ patron: /^\d{4}-\d{2}-\d{2}$/ })),
      }),
      reason: motivo,
    }),
    objetivo, motivo: porMotivo,
    ejecutar: (i, ctx) => {
      // Solo las llaves presentes: license_qa_grant usa `?` para saber qué cambiar.
      const grants = Object.fromEntries(Object.entries(i.grants).filter(([, v]) => v !== null));
      return llamar(ctx, 'license_qa_grant', { p_license: i.id, p_grants: grants, p_reason: i.reason, p_actor: ctx.firma });
    },
  }),
  comando({
    nombre: 'licencia.candidata_cancelar', tipo: 'cambio', rol: 'OPERATOR',
    entrada: objeto({ id: uuid, reason: motivo }),
    objetivo, motivo: porMotivo,
    ejecutar: (i, ctx) => llamar(ctx, 'license_mark_cancel_candidate', { p_license: i.id, p_reason: i.reason, p_actor: ctx.firma }),
  }),
  comando({
    nombre: 'adaptacion.registrar', tipo: 'cambio', rol: 'OPERATOR',
    entrada: objeto({
      id: uuid, kind: uno('CUSTOMIZATION', 'BUG_FIX', 'IMPLEMENTATION'),
      title: texto({ min: 3, max: 160 }), description: opcional(texto({ max: 2000 })),
    }),
    objetivo,
    ejecutar: (i, ctx) => llamar(ctx, 'license_register_code_change', {
      p_license: i.id, p_kind: i.kind, p_title: i.title, p_description: i.description, p_actor: ctx.firma,
    }),
  }),
  comando({
    nombre: 'adaptacion.estado', tipo: 'cambio', rol: 'OPERATOR',
    entrada: objeto({ change_id: uuid, status: uno('REGISTRADO', 'EN_PROCESO', 'ENTREGADO', 'CANCELADO') }),
    objetivo: (i) => `adaptacion:${i.change_id}`,
    ejecutar: (i, ctx) => llamar(ctx, 'license_code_change_set_status', { p_change: i.change_id, p_status: i.status, p_actor: ctx.firma }),
  }),
];
