/**
 * LA BASE LOCAL, SIN ATARSE A UN MOTOR.
 *
 * En la tablet es expo-sqlite con SQLCipher; en las pruebas, node:sqlite. Las
 * dos ejecutan EL MISMO SQL. Lo que importa de la interfaz:
 *
 *   transaccion(fn)  todo lo de `fn` se confirma junto o no se confirma nada.
 *                    Es exclusiva: ninguna otra escritura se intercala (en la
 *                    tablet, una cola sobre LA conexión cifrada: ver
 *                    apps/pos-mobile/lib/base.ts).
 */
export type Param = string | number | null;

export interface Sql {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: Param[]): Promise<{ changes: number; lastInsertRowId: number }>;
  all<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T | null>;
}

export interface BaseLocal extends Sql {
  transaccion<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
}

/**
 * Adaptador para node:sqlite (pruebas y herramientas). Serializa las
 * transacciones con una cola: así se comporta como la exclusiva de la tablet.
 */
export function adaptadorNode(db: {
  exec(sql: string): void;
  prepare(sql: string): { run(...p: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }; all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown };
}): BaseLocal {
  // Igual que en la tablet: TODO pasa por una cola. Usar la base "de afuera"
  // dentro de una transacción se queda esperando (y las pruebas lo detectan).
  let cola: Promise<unknown> = Promise.resolve();
  const enCola = <T>(fn: () => Promise<T>): Promise<T> => {
    const r = cola.then(fn);
    cola = r.catch(() => undefined);
    return r;
  };
  const sql: Sql = {
    async exec(s) { db.exec(s); },
    async run(s, p = []) { const r = db.prepare(s).run(...p); return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) }; },
    async all(s, p = []) { return db.prepare(s).all(...p) as never[]; },
    async get(s, p = []) { return (db.prepare(s).get(...p) ?? null) as never; },
  };
  return {
    exec: (s) => enCola(() => sql.exec(s)),
    run: (s, p) => enCola(() => sql.run(s, p)),
    all: (s, p) => enCola(() => sql.all(s, p)) as never,
    get: (s, p) => enCola(() => sql.get(s, p)) as never,
    transaccion<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      return enCola(async () => {
        db.exec('BEGIN IMMEDIATE');
        try { const v = await fn(sql); db.exec('COMMIT'); return v; }
        catch (e) { db.exec('ROLLBACK'); throw e; }
      });
    },
  };
}
