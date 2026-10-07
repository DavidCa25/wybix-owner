# Contrato comercial de Owner y POS Mobile

Owner/POS Mobile 0.2.0. Implementación aprobada: precios por canal, promociones automáticas y combos sobre productos reales. Guía de configuración y demo: `C:/Users/Casillas/filtros_lubs_rios/docs/comercial/README.md`.

## Contratos

- `Catalogo.commercial` es opcional para conservar catálogos anteriores. Contiene versión, canales, precios, promociones y combos.
- `packages/domain/src/comercial.ts` es una copia exacta del motor de Windows. Las operaciones usan centavos enteros y el reloj corregido del negocio. `precios-venta.ts` conserva receta, costo y consumos físicos; distribuye esos consumos cuando una promoción separa una partida.
- La migración SQLite 3 añade los snapshots comerciales de venta y partidas sin borrar datos anteriores.
- `registrarVenta` vuelve a cotizar dentro de la transacción antes de validar pago y guardar venta, stock y outbox. El rol CASHIER no puede confirmar elegibilidad de descuentos por parámetros.
- Vender permite canal por cuenta, componentes y opciones del combo, ahorro, precios aplicados y pago PLATAFORMA. Al terminar la cuenta se restablece Mostrador.
- `SALE_RECORDED.payload.commercial` y los snapshots de partidas llegan a `sales_facts.commercial_snapshot` y `sale_line_facts.commercial_snapshot`; los hechos históricos no se reinterpretan con listas nuevas.
- `commercial_sales_summary(uuid,date)` exige membresía y ubicación autorizadas. Owner muestra venta menos devolución por canal, antes de comisiones de plataformas.

## Nube y compatibilidad

Se aplicaron, verificaron y registraron las migraciones `20261012120000_comercial_snapshot` y `20261012130000_comercial_compatibilidad_reportes`. Las pruebas restauradas usan Postgres 17, permisos por defecto de Supabase, doble aplicación y usuarios authenticated de distintas empresas.

El snapshot con reglas activas requiere `commercial_schema: 1`. El cliente nuevo lo envía; el adaptador fuente `supabase/functions/_shared/pos-sync.ts` lo sanitiza. Una incompatibilidad devuelve HTTP 409 / UPDATE_REQUIRED y no entrega el catálogo. No revoca la credencial del equipo.

**El adaptador pos-sync actualizado todavía no está desplegado.** Tampoco se publicaron estos exports ni APK nuevos. Antes de activar reglas en clientes, desplegar el adaptador, distribuir ambos clientes y comprobar publicación de catálogo, refresh, venta/outbox/proyección y reporte con el piloto. Los clientes antiguos que aún operan con catálogo cacheado sin conexión deben actualizarse explícitamente.

`docs/comercial/verificar-nube.sql` es un smoke de solo lectura con resultados booleanos; no muestra datos de clientes ni credenciales.

## Verificación

Los recorridos WebKit usan bóveda, navegador, equipo y servidor temporales con transporte externo bloqueado. Comprueban PIN ficticio, venta por canal de $64, combo de $59, consumos de dona/receta, dos ventas/outbox, efectivo esperado y recarga sin conexión. La prueba de almacenamiento verifica cifrado, llave no exportable, rollback por cuota, integridad referencial y bloqueo de segunda pestaña.

Ejecutar desde la raíz:

```powershell
npm test
npm run typecheck
npm run test:fase3
npm run build:pwa:pos
npm run build:pwa:owner
# PLAYWRIGHT_MODULE permite usar un Playwright instalado en el entorno.
# ESBUILD_MODULE permite usar esbuild; por defecto se busca también en el repositorio Windows vecino.
node scripts/probar-comercial-web.cjs
node scripts/probar-pwa-almacenamiento.cjs
supabase db query --linked --file docs/comercial/verificar-nube.sql -o json
```

No publicar ni activar ofertas como parte de las pruebas. La validación física de teléfono, impresora y Point sigue siendo parte del piloto. Evidencia saneada: `docs/evidencia/comercial-20261007/`.
