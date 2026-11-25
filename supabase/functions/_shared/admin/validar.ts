// ============================================================================
//  VALIDACIÓN DE ENTRADA DEL PANEL (sin dependencias: corre en Deno y Node)
// ----------------------------------------------------------------------------
//  Combinadores pequeños: cada `Validador<T>` convierte un `unknown` en `T` o
//  lanza `ErrorValidacion` con la ruta del campo. Los comandos declaran su
//  esquema con ellos; el manejador lo aplica ANTES de tocar la base.
// ============================================================================

export class ErrorValidacion extends Error {
  readonly campo: string;
  constructor(campo: string, mensaje: string) {
    super(`${campo}: ${mensaje}`);
    this.campo = campo;
  }
}

export type Validador<T> = (v: unknown, campo: string) => T;
export type Infer<V> = V extends Validador<infer T> ? T : never;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const texto = (opts: { min?: number; max?: number; patron?: RegExp } = {}): Validador<string> => (v, campo) => {
  if (typeof v !== 'string') throw new ErrorValidacion(campo, 'debe ser texto');
  const s = v.trim();
  if (s.length < (opts.min ?? 1)) throw new ErrorValidacion(campo, `mínimo ${opts.min ?? 1} caracteres`);
  if (s.length > (opts.max ?? 500)) throw new ErrorValidacion(campo, `máximo ${opts.max ?? 500} caracteres`);
  if (opts.patron && !opts.patron.test(s)) throw new ErrorValidacion(campo, 'formato inválido');
  return s;
};

export const uuid: Validador<string> = (v, campo) => {
  if (typeof v !== 'string' || !UUID.test(v)) throw new ErrorValidacion(campo, 'debe ser un UUID');
  return v.toLowerCase();
};

export const entero = (min: number, max: number): Validador<number> => (v, campo) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw new ErrorValidacion(campo, `entero entre ${min} y ${max}`);
  }
  return n;
};

export const importe: Validador<number> = (v, campo) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 10_000_000) throw new ErrorValidacion(campo, 'importe inválido');
  return Math.round(n * 100) / 100;
};

export const booleano: Validador<boolean> = (v, campo) => {
  if (typeof v !== 'boolean') throw new ErrorValidacion(campo, 'debe ser verdadero o falso');
  return v;
};

export const uno = <const T extends readonly string[]>(...valores: T): Validador<T[number]> => (v, campo) => {
  if (typeof v !== 'string' || !valores.includes(v)) throw new ErrorValidacion(campo, `uno de: ${valores.join(', ')}`);
  return v as T[number];
};

export const opcional = <T>(val: Validador<T>): Validador<T | null> => (v, campo) =>
  v === undefined || v === null || v === '' ? null : val(v, campo);

export const lista = <T>(val: Validador<T>, max = 20): Validador<T[]> => (v, campo) => {
  if (!Array.isArray(v) || v.length > max) throw new ErrorValidacion(campo, `lista de hasta ${max}`);
  return v.map((x, i) => val(x, `${campo}[${i}]`));
};

type Forma = Record<string, Validador<unknown>>;
export type DeForma<F extends Forma> = { [K in keyof F]: Infer<F[K]> };

/** Objeto con campos conocidos. Los campos de más se DESCARTAN (no viajan a la base). */
export const objeto = <F extends Forma>(forma: F): Validador<DeForma<F>> => (v, campo) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ErrorValidacion(campo, 'debe ser un objeto');
  const o = v as Record<string, unknown>;
  const r: Record<string, unknown> = {};
  for (const k of Object.keys(forma)) r[k] = forma[k](o[k], campo ? `${campo}.${k}` : k);
  return r as DeForma<F>;
};

// ------------------------------------------------------------ comunes del dominio
export const motivo = texto({ min: 5, max: 500 });
export const giro = uno('COMMERCE', 'HOSPITALITY', 'SERVICES');
export const pago = objeto({
  provider: uno('TRANSFER', 'CASH', 'COURTESY', 'PAYPAL'),
  ref: opcional(texto({ max: 120 })),
  amount: opcional(importe),
});
