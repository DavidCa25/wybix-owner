// ============================================================================
//  COMANDOS DE OPERACIÓN: pruebas, equipos de nube, apps del dueño, menú en
//  línea (OPERATOR) y plataforma: precios, versiones, administradores (OWNER).
// ============================================================================
import { comando, llamar } from './nucleo.ts';
import { booleano, entero, importe, motivo, objeto, opcional, texto, uno, uuid } from './validar.ts';

const porMotivo = (i: { reason: string }) => i.reason;
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

export const operacion = [
  comando({
    nombre: 'prueba.extender', tipo: 'cambio', rol: 'OPERATOR',
    entrada: objeto({ machine_id: texto({ min: 8, max: 128 }), days: entero(1, 90), reason: motivo }),
    objetivo: (i) => `equipo:${i.machine_id}`, motivo: porMotivo,
    ejecutar: (i, ctx) => llamar(ctx, 'device_trial_extend', { p_machine_id: i.machine_id, p_days: i.days, p_reason: i.reason, p_actor: ctx.firma }),
  }),
  comando({
    nombre: 'equipo.revocar', tipo: 'cambio', rol: 'OPERATOR',
    entrada: objeto({ device_id: uuid, reason: motivo }),
    objetivo: (i) => `dispositivo:${i.device_id}`, motivo: porMotivo,
    ejecutar: (i, ctx) => llamar(ctx, 'device_set_status', { p_device: i.device_id, p_status: 'REVOKED', p_reason: i.reason, p_actor: ctx.firma }),
  }),
  comando({
    nombre: 'apps.cupo', tipo: 'cambio', rol: 'OPERATOR',
    entrada: objeto({ negocio_id: uuid, total: entero(1, 50), reason: motivo }),
    objetivo: (i) => `negocio:${i.negocio_id}`, motivo: porMotivo,
    ejecutar: (i, ctx) => llamar(ctx, 'owner_app_quota_set', { p_negocio: i.negocio_id, p_total: i.total, p_reason: i.reason, p_actor: ctx.firma }),
  }),
  comando({
    nombre: 'apps.activa', tipo: 'cambio', rol: 'OPERATOR',
    entrada: objeto({ app_id: uuid, active: booleano, reason: motivo }),
    objetivo: (i) => `app:${i.app_id}`, motivo: porMotivo,
    ejecutar: (i, ctx) => llamar(ctx, 'owner_app_set_active', { p_app: i.app_id, p_active: i.active, p_reason: i.reason, p_actor: ctx.firma }),
  }),
  comando({
    nombre: 'menu.actualizar', tipo: 'cambio', rol: 'OPERATOR',
    entrada: objeto({
      location_id: uuid,
      slug: opcional(texto({ min: 3, max: 40, patron: /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/ })),
      activo: opcional(booleano),
      reason: motivo,
    }),
    objetivo: (i) => `sucursal:${i.location_id}`, motivo: porMotivo,
    ejecutar: (i, ctx) => {
      const cambios: Record<string, unknown> = {};
      if (i.slug !== null) cambios.slug = i.slug;
      if (i.activo !== null) cambios.activo = i.activo;
      if (!Object.keys(cambios).length) return Promise.resolve({ ok: false, code: 'BAD_REQUEST', error: 'Nada que cambiar.' });
      return llamar(ctx, 'menu_admin_update', { p_location: i.location_id, p_changes: cambios, p_reason: i.reason, p_actor: ctx.firma });
    },
  }),

  // ------------------------------------------------------------ solo OWNER
  comando({
    nombre: 'catalogo.precio', tipo: 'cambio', rol: 'OWNER',
    entrada: objeto({
      code: texto({ max: 60, patron: /^[A-Z0-9_]+$/ }),
      list_price: opcional(importe), reference_price: opcional(importe), active: opcional(booleano),
      reason: motivo,
    }),
    objetivo: (i) => `catalogo:${i.code}`, motivo: porMotivo,
    ejecutar: (i, ctx) => {
      const cambios: Record<string, unknown> = {};
      if (i.list_price !== null) cambios.list_price = i.list_price;
      if (i.reference_price !== null) cambios.reference_price = i.reference_price;
      if (i.active !== null) cambios.active = i.active;
      if (!Object.keys(cambios).length) return Promise.resolve({ ok: false, code: 'BAD_REQUEST', error: 'Nada que cambiar.' });
      return llamar(ctx, 'license_catalog_update', { p_code: i.code, p_changes: cambios, p_reason: i.reason, p_actor: ctx.firma });
    },
  }),
  comando({
    nombre: 'release.publicar', tipo: 'cambio', rol: 'OWNER',
    entrada: objeto({
      app: texto({ max: 31, patron: /^[a-z][a-z0-9-]{1,30}$/ }), channel: uno('production', 'beta'),
      latest: texto({ patron: SEMVER }), min: texto({ patron: SEMVER }), notes: opcional(texto({ max: 2000 })),
    }),
    objetivo: (i) => `release:${i.app}/${i.channel}`,
    ejecutar: (i, ctx) => llamar(ctx, 'app_release_upsert', {
      p_app: i.app, p_channel: i.channel, p_latest: i.latest, p_min: i.min, p_notes: i.notes, p_actor: ctx.firma,
    }),
  }),
  comando({
    nombre: 'admin.asignar', tipo: 'cambio', rol: 'OWNER',
    entrada: objeto({
      email: texto({ max: 160, patron: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ }),
      role: uno('OWNER', 'OPERATOR', 'VIEWER'), active: booleano,
    }),
    objetivo: (i) => `admin:${i.email.toLowerCase()}`,
    ejecutar: (i, ctx) => llamar(ctx, 'platform_admin_set', { p_email: i.email, p_role: i.role, p_active: i.active, p_actor_id: ctx.actor.id }),
  }),
];
