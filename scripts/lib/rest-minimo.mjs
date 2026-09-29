/**
 * UN POSTGREST MÍNIMO PARA PRUEBAS (sin descargar nada).
 *
 * Atiende exactamente lo que usan las funciones /api de la web contra
 * Supabase, sobre el Postgres desechable de las pruebas:
 *
 *   GET  /rest/v1/<tabla>?select=a,b&col=eq.x&order=c.asc&limit=n
 *   POST /rest/v1/<tabla>          (arreglo de filas; columnas omitidas = DEFAULT)
 *   POST /rest/v1/rpc/<funcion>    (argumentos con nombre)
 *
 * Cada petición corre con el ROL de su clave (anon o service_role), igual
 * que PostgREST: los privilegios y RLS de la migración se aplican de verdad.
 * Errores con el mismo código HTTP que PostgREST (409 duplicado, 400
 * restricción, 401/403 sin privilegio).
 */
import { createServer } from 'node:http';

const ident = (s) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`identificador inválido: ${s}`); return s; };
const texto = (v) => `'${String(v).replace(/'/g, "''")}'`;
function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') return `${texto(JSON.stringify(v))}::jsonb`;
  return texto(v);
}

export function crearRest(psql, claves) {
  const server = createServer(async (req, res) => {
    const enviar = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    try {
      const u = new URL(req.url, 'http://local');
      if (!u.pathname.startsWith('/rest/v1/')) return enviar(404, { message: 'ruta' });
      const rol = claves[req.headers.apikey];
      if (!rol) return enviar(401, { message: 'clave inválida' });
      let cuerpo = '';
      for await (const c of req) cuerpo += c;
      const ruta = u.pathname.slice('/rest/v1/'.length);
      let sql;
      if (ruta.startsWith('rpc/')) {
        const args = cuerpo ? JSON.parse(cuerpo) : {};
        const lista = Object.entries(args).map(([k, v]) => `${ident(k)} => ${literal(v)}`).join(', ');
        sql = `select coalesce(to_json(public.${ident(ruta.slice(4))}(${lista})), 'null'::json);`;
      } else if (req.method === 'GET') {
        const tabla = ident(ruta);
        const cols = (u.searchParams.get('select') || '*').split(',').map(c => c === '*' ? '*' : ident(c.trim())).join(', ');
        const donde = [];
        for (const [k, v] of u.searchParams) {
          if (['select', 'order', 'limit'].includes(k)) continue;
          const [op, ...resto] = v.split('.'); const val = resto.join('.');
          if (op === 'eq') donde.push(`${ident(k)} = ${texto(val)}`);
          else if (op === 'in') donde.push(`${ident(k)} in (${val.replace(/^\(|\)$/g, '').split(',').map(texto).join(', ')})`);
          else throw new Error(`filtro no soportado: ${op}`);
        }
        const orden = (u.searchParams.get('order') || '').split(',').filter(Boolean)
          .map(o => { const [c, d] = o.split('.'); return `${ident(c)} ${d === 'desc' ? 'desc' : 'asc'}`; }).join(', ');
        const lim = u.searchParams.get('limit');
        sql = `select coalesce(json_agg(t), '[]'::json) from (select ${cols} from public.${tabla}` +
              `${donde.length ? ' where ' + donde.join(' and ') : ''}${orden ? ' order by ' + orden : ''}${lim ? ' limit ' + Number(lim) : ''}) t;`;
      } else if (req.method === 'POST') {
        const tabla = ident(ruta);
        const filas = [].concat(JSON.parse(cuerpo || '[]'));
        const cols = [...new Set(filas.flatMap(f => Object.keys(f)))].map(ident);
        sql = `with ins as (insert into public.${tabla} (${cols.join(', ')}) select ${cols.join(', ')} from json_populate_recordset(null::public.${tabla}, ${texto(JSON.stringify(filas))}) returning *)` +
              ` select coalesce(json_agg(ins), '[]'::json) from ins;`;
      } else {
        return enviar(405, { message: 'método' });
      }
      const r = psql(`set role ${ident(rol)};\n${sql}`);
      if (r.code !== 0) {
        const e = r.err;
        if (/duplicate key/.test(e)) return enviar(409, { code: '23505', message: e.trim() });
        if (/violates check constraint|violates not-null/.test(e)) return enviar(400, { code: '23514', message: e.trim() });
        if (/permission denied/.test(e)) return enviar(rol === 'anon' ? 401 : 403, { code: '42501', message: e.trim() });
        return enviar(400, { message: e.trim() });
      }
      const salida = r.out.trim();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(salida || 'null');
    } catch (err) {
      enviar(400, { message: String(err.message || err) });
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${server.address().port}`, cerrar: () => server.close() })));
}
