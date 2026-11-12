/**
 * CANAL DE PRECIOS CON EL QUE EMPIEZA CADA CUENTA en la tablet.
 *
 * La dueña lo elige por evento en Wybix Owner (location.default_channel en el
 * snapshot). Solo vale si el catálogo de la tablet todavía lo trae ACTIVO: si
 * la sucursal base lo quitó o lo apagó, la cuenta empieza en Mostrador.
 * Archivo aparte de comercial.ts: aquel debe ser idéntico al del escritorio.
 */
import type { PoliticaComercial } from './comercial.ts';

export const CANAL_MOSTRADOR = 'LOCAL';

export function canalInicial(politica: PoliticaComercial | null | undefined, predeterminado: string | null | undefined): string {
  if (!predeterminado || !politica) return CANAL_MOSTRADOR;
  return politica.channels.some((c) => c.id === predeterminado && c.active) ? predeterminado : CANAL_MOSTRADOR;
}
