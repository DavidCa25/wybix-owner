/**
 * FASE 3 · SINCRONIZACIÓN EN SEGUNDO PLANO.
 *
 * expo-background-task usa WorkManager en Android: Android decide CUÁNDO
 * corre (mínimo ~15 min, y puede posponerlo por batería o modo Doze). Por eso
 * la integridad nunca depende de esto: el outbox está en la base y se envía
 * al abrir la app, al recuperar la red y cada minuto mientras está al frente.
 *
 * Esta tarea abre su propia conexión a la base cifrada y corre UN ciclo del
 * mismo motor. Correr de más no hace daño: la nube es idempotente.
 */
import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';
import { crearPos, guardarDesfase } from '@wybix/database';
import { crearSincronizador } from '@wybix/sync';
import { crearClienteNube } from '@wybix/api';
import { abrirBase } from './base';
import { CONFIG } from './config';
import { credencial, deviceUuid } from './llaves';

export const TAREA = 'wybix-sincronizar';

TaskManager.defineTask(TAREA, async () => {
  const inicio = new Date().toISOString();
  let base: Awaited<ReturnType<typeof abrirBase>> | null = null;
  try {
    if (!(await credencial.leer())) return BackgroundTask.BackgroundTaskResult.Success;
    base = await abrirBase();
    const { db } = base;
    await db.run(`INSERT INTO kv (k, v) VALUES ('fondo_ultimo', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, [JSON.stringify({ inicio, estado: 'RUNNING' })]);
    const pos = crearPos(db);
    const nube = crearClienteNube({
      base: CONFIG.backend, anonKey: CONFIG.anonKey, version: CONFIG.version, credencial: credencial.leer,
      identidad: async () => { try { const i = await pos.identidad(); return { company_uuid: i.company_uuid, location_uuid: i.location_uuid }; } catch { return null; } },
    });
    const e = await crearSincronizador({ db, nube, dispositivo: deviceUuid, version: CONFIG.version }).sincronizar();
    const desfase = nube.desfase();
    if (desfase) await guardarDesfase(db, desfase.ms, desfase.at);
    const ok = e.en_linea && !e.revocado;
    await db.run(`INSERT INTO kv (k, v) VALUES ('fondo_ultimo', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, [JSON.stringify({ inicio, at: new Date().toISOString(), estado: ok ? 'SUCCESS' : 'FAILED', pendientes: e.pendientes, rechazados: e.rechazados, cuarentena: e.cuarentena })]);
    return ok ? BackgroundTask.BackgroundTaskResult.Success : BackgroundTask.BackgroundTaskResult.Failed;
  } catch {
    if (base) await base.db.run(`INSERT INTO kv (k, v) VALUES ('fondo_ultimo', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, [JSON.stringify({ inicio, at: new Date().toISOString(), estado: 'FAILED' })]).catch(() => undefined);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registrarFondo() {
  const s = await BackgroundTask.getStatusAsync();
  if (s !== BackgroundTask.BackgroundTaskStatus.Available) return false;
  if (!(await TaskManager.isTaskRegisteredAsync(TAREA))) await BackgroundTask.registerTaskAsync(TAREA, { minimumInterval: 15 });
  return true;
}
