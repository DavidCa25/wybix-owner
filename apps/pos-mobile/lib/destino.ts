/**
 * A QUIÉN LE ENTREGA ESTA TABLET LO QUE HACE (POS 0094).
 *
 *   EVENTO    la nube de Wybix (pos-sync), con Internet.
 *   SUCURSAL  el Local Host de la computadora principal, por la red del local.
 *
 * El modo lo fija el emparejamiento y vive en la base (kv 'modo'). Los dos
 * cumplen la misma interfaz `Nube`: el motor de sincronización, el outbox y
 * las pantallas no distinguen. Lo único que solo existe en EVENTO es lo que
 * depende de la nube: aprobaciones a distancia y desfase del reloj.
 */
import { modoDeOperacion, type BaseLocal, type PosLocal } from '@wybix/database';
import type { Nube } from '@wybix/sync';
import { crearClienteNube, crearClienteLocalHost } from '@wybix/api';
import { CONFIG } from './config';
import { credencial } from './llaves';

export type Destino =
  | { modo: 'EVENTO'; nube: Nube; cloud: ReturnType<typeof crearClienteNube> }
  | { modo: 'SUCURSAL'; nube: Nube; cloud: null; localHost: string };

export function clienteNube(pos: PosLocal) {
  return crearClienteNube({
    base: CONFIG.backend, anonKey: CONFIG.anonKey, version: CONFIG.version, credencial: credencial.leer,
    identidad: async () => { try { const i = await pos.identidad(); return { company_uuid: i.company_uuid, location_uuid: i.location_uuid }; } catch { return null; } },
  });
}

export async function armarDestino(db: BaseLocal, pos: PosLocal): Promise<Destino> {
  const m = await modoDeOperacion(db);
  if (m.modo === 'SUCURSAL' && m.local_host) {
    return { modo: 'SUCURSAL', localHost: m.local_host, cloud: null,
      nube: crearClienteLocalHost({ base: m.local_host, credencial: credencial.leer, version: CONFIG.version }) };
  }
  const cloud = clienteNube(pos);
  return { modo: 'EVENTO', nube: cloud, cloud };
}
