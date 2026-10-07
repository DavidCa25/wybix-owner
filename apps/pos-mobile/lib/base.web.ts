import type { Database, SqlJsStatic } from 'sql.js';
import { migrar, type BaseLocal, type Sql, type Param } from '@wybix/database';
import { readVault, writeVault } from './web-vault';
export const ARCHIVO = 'wybix-pos.db';
let opening: Promise<{db: BaseLocal; nativa: Database; migracion: {desde: number; hasta: number}}> | null = null;
let ownsLock=false;
async function exclusiveBrowser(): Promise<void> {
  if(ownsLock)return;
  if (!navigator.locks) throw new Error('Actualiza Safari para guardar ventas sin conexión.');
  await new Promise<void>((resolve, reject) => {
    void navigator.locks.request('wybix-pos-writer', {ifAvailable:true}, async lock => {
      if (!lock) { reject(new Error('POS Mobile ya está abierto. Usa una sola pestaña o la app de la pantalla de inicio.')); return; }
      ownsLock=true;resolve(); await new Promise<void>(() => {});
    }).catch(reject);
  });
}
async function sqlite(): Promise<SqlJsStatic> {
  const g = globalThis as unknown as {initSqlJs?: (o: {locateFile(name: string): string}) => Promise<SqlJsStatic>};
  if (!g.initSqlJs) await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script'); script.src = '/sqlite/sql-wasm.js';
    script.onload = () => resolve(); script.onerror = () => reject(new Error('No se pudo cargar el almacenamiento. Abre la app con Internet una vez.')); document.head.appendChild(script);
  });
  return g.initSqlJs!({locateFile: name => '/sqlite/'+name});
}
export async function baseWeb(SQL: SqlJsStatic, initial: Uint8Array | null, save: (b: Uint8Array) => Promise<void>): Promise<BaseLocal> {
  let x = initial ? new SQL.Database(initial) : new SQL.Database();
  const settings = () => x.run('PRAGMA foreign_keys=ON;'); settings();
  const snapshot = () => { const b=x.export(); settings(); return b; };
  const sql: Sql = {
    exec: async s => { x.exec(s); },
    run: async (s,p: Param[]=[]) => { x.run(s,p); const id=x.exec('SELECT last_insert_rowid() AS n')[0]?.values[0][0]; return {changes:x.getRowsModified(),lastInsertRowId:Number(id??0)}; },
    all: async <T>(s: string,p: Param[]=[]) => { const statement=x.prepare(s); try { statement.bind(p); const rows:T[]=[]; while(statement.step())rows.push(statement.getAsObject() as T); return rows; } finally {statement.free();} },
    get: async <T>(s: string,p: Param[]=[]) => (await sql.all<T>(s,p))[0]??null,
  };
  let tail:Promise<unknown>=Promise.resolve();
  const queue=<T>(fn:()=>Promise<T>)=>{const p=tail.then(fn);tail=p.catch(()=>{});return p;};
  const transaction=async <T>(fn:(tx:Sql)=>Promise<T>)=> {
    const before=snapshot();
    try { x.run('BEGIN IMMEDIATE');const value=await fn(sql);x.run('COMMIT');await save(snapshot());return value; }
    catch(e){x.close();x=new SQL.Database(before);settings();throw e;}
  };
  return {exec:s=>queue(()=>transaction(tx=>tx.exec(s))),run:(s,p)=>queue(()=>transaction(tx=>tx.run(s,p))),all:(s,p)=>queue(()=>sql.all(s,p)),get:(s,p)=>queue(()=>sql.get(s,p)),transaccion:fn=>queue(()=>transaction(fn))};
}
export function abrirBase() {
  if(!opening) opening=(async()=>{
    await exclusiveBrowser();
    const SQL=await sqlite();const initial=await readVault(ARCHIVO);const db=await baseWeb(SQL,initial,b=>writeVault(ARCHIVO,b));
    const m=await migrar(db);await navigator.storage?.persist?.().catch(()=>false);
    return {db,nativa:null as unknown as Database,migracion:m};
  })();
  opening.catch(()=>{opening=null;});return opening;
}
