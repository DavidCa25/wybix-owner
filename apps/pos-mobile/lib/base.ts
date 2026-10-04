/**
 * SQLite CIFRADO (expo-sqlite + SQLCipher) con la interfaz de @wybix/database.
 * La llave se aplica ANTES de cualquier otra cosa; si no abre, se detiene.
 */
import * as SQLite from 'expo-sqlite';
import { migrar, type BaseLocal, type Sql, type Param } from '@wybix/database';
import { llaveBase } from './llaves';

export const ARCHIVO = 'wybix-pos.db';

function envolver(x: SQLite.SQLiteDatabase): Sql {
  return {
    exec: async (s) => { await x.execAsync(s); },
    run: async (s, p: Param[] = []) => { const r = await x.runAsync(s, p as SQLite.SQLiteBindParams); return { changes: r.changes, lastInsertRowId: r.lastInsertRowId }; },
    all: (s, p: Param[] = []) => x.getAllAsync(s, p as SQLite.SQLiteBindParams) as never,
    get: async (s, p: Param[] = []) => ((await x.getFirstAsync(s, p as SQLite.SQLiteBindParams)) ?? null) as never,
  };
}

/**
 * La interfaz BaseLocal sobre UNA conexión ya abierta con su llave.
 */
export function baseCifrada(nativa: SQLite.SQLiteDatabase): BaseLocal {
  // UNA conexión y una cola. No se usa withExclusiveTransactionAsync: abre
  // OTRA conexión, que no tiene la llave de SQLCipher ("file is not a
  // database"). Todo pasa por la cola: una escritura suelta nunca cae dentro
  // de la transacción de otro (ni se deshace con su ROLLBACK).
  const directa = envolver(nativa);
  let cola: Promise<unknown> = Promise.resolve();
  const enCola = <T>(fn: () => Promise<T>): Promise<T> => {
    const r = cola.then(fn);
    cola = r.catch(() => undefined);
    return r;
  };
  return {
    exec: (s) => enCola(() => directa.exec(s)),
    run: (s, p) => enCola(() => directa.run(s, p)),
    all: (s, p) => enCola(() => directa.all(s, p)) as never,
    get: (s, p) => enCola(() => directa.get(s, p)) as never,
    transaccion: <T>(fn: (tx: Sql) => Promise<T>) => enCola(async () => {
      await nativa.execAsync('BEGIN IMMEDIATE');
      try { const v = await fn(directa); await nativa.execAsync('COMMIT'); return v; }
      catch (e) { await nativa.execAsync('ROLLBACK').catch(() => undefined); throw e; }
    }),
  };
}

type Abierta = { db: BaseLocal; nativa: SQLite.SQLiteDatabase; migracion: { desde: number; hasta: number } };
let abierta: Promise<Abierta> | null = null;

/** Una sola conexión por proceso: la pantalla y la tarea de fondo comparten la misma. */
export function abrirBase(): Promise<Abierta> {
  if (!abierta) {
    abierta = abrir();
    abierta.catch(() => { abierta = null; });
  }
  return abierta;
}

async function abrir(): Promise<Abierta> {
  const nativa = await SQLite.openDatabaseAsync(ARCHIVO);
  await nativa.execAsync(`PRAGMA key = "x'${await llaveBase()}'"`);
  // Si la llave no abre la base, esto falla aquí (y no a la mitad de una venta).
  await nativa.getFirstAsync('SELECT count(*) AS n FROM sqlite_master');
  await nativa.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const db = baseCifrada(nativa);
  const m = await migrar(db);
  return { db, nativa, migracion: m };
}
