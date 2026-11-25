// ============================================================================
//  CONSULTAS DEL PANEL (solo lectura). Cada una es una función admin_q_* de
//  Postgres: la forma de la respuesta la decide la base.
// ============================================================================
import { comando, llamar } from './nucleo.ts';
import { booleano, entero, objeto, opcional, texto, uno, uuid } from './validar.ts';

const nada = objeto({});

export const consultas = [
  comando({
    nombre: 'yo', tipo: 'consulta', rol: 'VIEWER', entrada: nada,
    ejecutar: async (_i, ctx) => ({ ok: true, data: { id: ctx.actor.id, email: ctx.actor.email, rol: ctx.actor.rol, permitidos: ctx.permitidos } }),
  }),
  comando({
    nombre: 'tablero', tipo: 'consulta', rol: 'VIEWER', entrada: nada,
    ejecutar: (_i, ctx) => llamar(ctx, 'admin_q_overview', {}),
  }),
  comando({
    nombre: 'negocio', tipo: 'consulta', rol: 'VIEWER', entrada: objeto({ id: uuid }),
    objetivo: (i) => `negocio:${i.id}`,
    ejecutar: (i, ctx) => llamar(ctx, 'admin_q_negocio', { p_negocio: i.id }, true),
  }),
  comando({
    nombre: 'licencias', tipo: 'consulta', rol: 'VIEWER',
    entrada: objeto({
      q: opcional(texto({ max: 80 })),
      status: opcional(uno('activa', 'suspendida', 'cancelada')),
      origin: opcional(uno('PRODUCTION', 'INTERNAL', 'QA', 'TEST', 'NONE')),
      limit: opcional(entero(1, 200)),
      offset: opcional(entero(0, 100_000)),
    }),
    ejecutar: (i, ctx) => llamar(ctx, 'admin_q_licencias', {
      p_q: i.q, p_status: i.status, p_origin: i.origin, p_limit: i.limit ?? 50, p_offset: i.offset ?? 0,
    }),
  }),
  comando({
    nombre: 'licencia', tipo: 'consulta', rol: 'VIEWER', entrada: objeto({ id: uuid }),
    objetivo: (i) => `licencia:${i.id}`,
    ejecutar: (i, ctx) => llamar(ctx, 'admin_q_licencia', { p_license: i.id }, true),
  }),
  comando({
    nombre: 'pruebas', tipo: 'consulta', rol: 'VIEWER',
    entrada: objeto({ q: opcional(texto({ max: 80 })), activas: opcional(booleano) }),
    ejecutar: (i, ctx) => llamar(ctx, 'admin_q_pruebas', { p_q: i.q, p_activas: i.activas ?? false, p_limit: 200 }),
  }),
  comando({
    nombre: 'comercial', tipo: 'consulta', rol: 'VIEWER', entrada: objeto({ meses: opcional(entero(1, 36)) }),
    ejecutar: (i, ctx) => llamar(ctx, 'admin_q_comercial', { p_meses: i.meses ?? 12 }),
  }),
  comando({
    nombre: 'revision', tipo: 'consulta', rol: 'VIEWER', entrada: nada,
    ejecutar: (_i, ctx) => llamar(ctx, 'admin_q_revision', {}),
  }),
  comando({
    nombre: 'adaptaciones', tipo: 'consulta', rol: 'VIEWER', entrada: objeto({ abiertas: opcional(booleano) }),
    ejecutar: (i, ctx) => llamar(ctx, 'admin_q_adaptaciones', { p_abiertas: i.abiertas ?? true }),
  }),
  comando({
    nombre: 'catalogo', tipo: 'consulta', rol: 'VIEWER', entrada: nada,
    ejecutar: (_i, ctx) => llamar(ctx, 'admin_q_catalogo', {}),
  }),
  comando({
    nombre: 'plataforma', tipo: 'consulta', rol: 'VIEWER', entrada: nada,
    ejecutar: (_i, ctx) => llamar(ctx, 'admin_q_plataforma', {}),
  }),
  comando({
    nombre: 'auditoria', tipo: 'consulta', rol: 'OPERATOR',
    entrada: objeto({ limit: opcional(entero(1, 500)), before: opcional(entero(1, Number.MAX_SAFE_INTEGER)), target: opcional(texto({ max: 80 })) }),
    ejecutar: (i, ctx) => llamar(ctx, 'admin_q_auditoria', { p_limit: i.limit ?? 100, p_before: i.before, p_target: i.target }),
  }),
  comando({
    nombre: 'admins', tipo: 'consulta', rol: 'OWNER', entrada: nada,
    ejecutar: (_i, ctx) => llamar(ctx, 'admin_q_admins', {}),
  }),
];
