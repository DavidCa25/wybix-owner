/**
 * DECIMAL EXACTO (BigInt escalado), con el mismo redondeo que SQL Server.
 *
 * El POS de Windows calcula precios, costos y consumos en DECIMAL de SQL
 * Server. Si el POS Mobile usara `number` (binario de 64 bits), 0.1 + 0.2
 * daría 0.30000000000000004 y una venta móvil terminaría con un costo o un
 * consumo distinto al de Windows por un centavo o una milésima: diferencias
 * silenciosas que el spike 2.3 prohíbe.
 *
 * Aquí cada valor es (entero, escala): 12.345 = (12345n, 3). Las sumas y los
 * productos son exactos; solo `redondear()` pierde precisión, y lo hace como
 * SQL Server al convertir a DECIMAL(p, s): mitad lejos del cero.
 */
export class Dec {
  readonly v: bigint;
  readonly s: number;
  // Sin "parameter properties": Node ejecuta este archivo quitando tipos y no las admite.
  private constructor(v: bigint, s: number) { this.v = v; this.s = s; }

  static de(x: string | number | bigint | Dec | null | undefined): Dec {
    if (x instanceof Dec) return x;
    if (x == null || x === '') return new Dec(0n, 0);
    if (typeof x === 'bigint') return new Dec(x, 0);
    const t = typeof x === 'number' ? numeroATexto(x) : String(x).trim();
    const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(t);
    if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new Error(`Decimal inválido: ${t}`);
    const frac = m[3] ?? '';
    const v = BigInt((m[2] || '0') + frac) * (m[1] === '-' ? -1n : 1n);
    return new Dec(v, frac.length);
  }

  static cero = new Dec(0n, 0);
  static uno = new Dec(1n, 0);

  private alinear(o: Dec): [bigint, bigint, number] {
    if (this.s === o.s) return [this.v, o.v, this.s];
    if (this.s > o.s) return [this.v, o.v * 10n ** BigInt(this.s - o.s), this.s];
    return [this.v * 10n ** BigInt(o.s - this.s), o.v, o.s];
  }

  mas(x: Dec | string | number): Dec { const [a, b, s] = this.alinear(Dec.de(x)); return new Dec(a + b, s); }
  menos(x: Dec | string | number): Dec { const [a, b, s] = this.alinear(Dec.de(x)); return new Dec(a - b, s); }
  por(x: Dec | string | number): Dec { const o = Dec.de(x); return new Dec(this.v * o.v, this.s + o.s); }
  neg(): Dec { return new Dec(-this.v, this.s); }

  /** División exacta solo entre potencias de 10 (p. ej. porcentaje / 100). */
  entre10(n: number): Dec { return new Dec(this.v, this.s + n); }

  /** Redondeo a `s` decimales, mitad lejos del cero (CAST de SQL Server). */
  redondear(s: number): Dec {
    if (this.s <= s) return new Dec(this.v * 10n ** BigInt(s - this.s), s);
    const f = 10n ** BigInt(this.s - s);
    const q = this.v / f;
    const r = this.v % f;
    const dobleResto = (r < 0n ? -r : r) * 2n;
    const ajuste = dobleResto >= f ? (this.v < 0n ? -1n : 1n) : 0n;
    return new Dec(q + ajuste, s);
  }

  comparar(x: Dec | string | number): number { const [a, b] = this.alinear(Dec.de(x)); return a === b ? 0 : a < b ? -1 : 1; }
  esCero(): boolean { return this.v === 0n; }
  esNegativo(): boolean { return this.v < 0n; }
  esPositivo(): boolean { return this.v > 0n; }

  /** Texto canónico sin ceros sobrantes ("12.5", "-0.25", "3"). */
  toString(): string {
    const neg = this.v < 0n;
    let d = (neg ? -this.v : this.v).toString();
    if (this.s > 0) {
      d = d.padStart(this.s + 1, '0');
      let ent = d.slice(0, d.length - this.s), fr = d.slice(d.length - this.s).replace(/0+$/, '');
      d = fr ? `${ent}.${fr}` : ent;
    }
    return (neg && d !== '0' ? '-' : '') + d;
  }

  /** Texto con exactamente `s` decimales (para DECIMAL(p, s)). */
  fijo(s: number): string {
    const r = this.redondear(s);
    const neg = r.v < 0n;
    let d = (neg ? -r.v : r.v).toString().padStart(s + 1, '0');
    if (s > 0) d = `${d.slice(0, d.length - s)}.${d.slice(d.length - s)}`;
    return (neg ? '-' : '') + d;
  }

  /** Centavos enteros (dinero). */
  centavos(): number { return Number(this.redondear(2).v); }
  toNumber(): number { return Number(this.toString()); }
  static deCentavos(c: number | bigint): Dec { return new Dec(BigInt(c), 2); }
  static suma(xs: Array<Dec | string | number>): Dec { return xs.reduce<Dec>((a, x) => a.mas(x), Dec.cero); }
}

function numeroATexto(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`Decimal inválido: ${n}`);
  // toString de JS evita la notación exponencial hasta 1e21; los montos de un POS están lejos de eso.
  const t = String(n);
  if (/e/i.test(t)) return n.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  return t;
}

export const D = Dec.de;
