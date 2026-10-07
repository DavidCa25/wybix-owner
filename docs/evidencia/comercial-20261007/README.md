# Evidencia final — Mobile y nube comercial

7 de octubre de 2026. Versiones Owner/POS Mobile 0.2.0; exports locales, sin publicación. Proveniencia y fingerprints de PWA: `proveniencia.json`.

| Verificación | Resultado | Registro |
| --- | --- | --- |
| Node: dominio, SQLite, sincronización, API y adaptadores | 97/97 | comercial-node-qa.log |
| TypeScript de todos los workspaces | Correcto | comercial-types-qa.log |
| Nube restaurada Postgres 17 y permisos Supabase | 80/80 | comercial-cloud-qa.log |
| Smoke remoto de columnas, permisos e historial comercial | Cinco flags verdaderos | smoke-remoto.json |
| Export PWA Owner | Correcto | comercial-pwa-owner-qa.log |
| Export PWA POS Mobile | Correcto | comercial-pwa-pos-qa.log |
| WebKit: PIN, venta por canal, combo, stock, caja, outbox y recarga sin red | Correcto | comercial-web-flow-qa.log |
| WebKit: bóveda cifrada, rollback por cuota, FK, concurrencia y segunda pestaña | Correcto | comercial-web-storage-qa.log |

El fixture WebKit contiene datos ficticios: 40 donas, recepción de transferencia, turno de $100, venta de dos donas por $64 en Uber QA y combo de dona/café por $59. Quedan 37 donas y 4,800 de leche; hay dos ventas/eventos, el cajón esperado sigue en $100 y ambos registros sobreviven a la recarga sin red. El transporte externo se bloquea antes de iniciar la aplicación.

Node comprueba que el motor móvil y el de Windows son idénticos, que pagos con importe anterior revierten completamente, que los consumos de recetas se preservan y que una cajera no puede forzar elegibilidad. El adaptador y el API comprueban capacidad comercial, identidad derivada del equipo y UPDATE_REQUIRED sin entregar catálogo ni revocar credenciales.

Las migraciones comerciales fueron ensayadas y aplicadas durante el desarrollo. El smoke remoto es de solo lectura. El adaptador pos-sync actualizado aún requiere despliegue y los clientes antiguos deben actualizarse antes de activar ofertas; no se publicaron APK/exports nuevos ni se activaron ejemplos en clientes reales.

La prueba WebKit no sustituye la validación física de iPhone/Android, impresión y terminal Point. Las comisiones/liquidaciones de plataformas y la importación automática de sus pedidos no forman parte de este cambio.
