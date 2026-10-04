# Evidencia funcional · Fase 2

Capturas de la app REAL en el emulador Android (tableta 2560×1600) contra una
nube local: Postgres 17 con las migraciones de la Fase 1 y 2 y la Edge Function
`pos-sync` real. Nada toca producción. I Do Nut sembrado: Centro, “Feria León
2026” abierta, catálogo y personal publicados, envío de 40 glaseadas + 24
rellenas + 10 vasos en camino.

## Wybix POS Mobile (tablet)

| # | Captura | Qué demuestra |
|---|---|---|
| 01 | enrolar | Enrolamiento por código (Company → EVENT → Caja → Equipo) |
| 02 | quien-atiende | Personal del evento con su rol en ESTE evento |
| 03 | pin-incorrecto | PIN verificado sin red; el incorrecto no entra |
| 04 | vender-sin-turno | Sin turno no se vende |
| 05 | mercancia-por-recibir | El envío de Centro llegó en el snapshot |
| 06 | sin-red-contar | **Red cortada**: se cuenta lo que llegó |
| 07 | autoriza-encargada | Recibir exige PIN de la encargada |
| 08 | recibido-sin-red | Existencias de la feria: 40 / 24 / 10 |
| 09 | fondo-inicial | Turno con fondo de $500 sin red |
| 10–12 | cobro, ticket, venta guardada | Efectivo $200 → cambio $100; F1-000001; stock 40 → 36 |
| 13 | reinicio | App cerrada y reabierta: pendientes intactos, pide PIN otra vez |
| 14 | ticket-tarjeta | F1-000002 con tarjeta (no toca el cajón) |
| 15–16 | merma | Merma de 1 vaso con autorización: 10 → 9 |
| 17–18 | force-stop | Proceso matado: 5 pendientes y el turno siguen |
| 19–20 | corte ciego | La cajera no ve el esperado; cuenta $590 |
| 21 | estado-sin-red | Pendientes, última sincronización, impresora, versión mínima |
| 22 | sincronizado | Al volver la red, sube solo: 6 hechos en orden, una vez |
| 23 | impresora-red | Ticket ESC/POS recibido por TCP 9100 (`23-…-recibido.txt`) |

En la nube, tras sincronizar: 2 ventas (F1-000001 $100, F1-000002 $64 con
factura pedida), turno CERRADO a ciegas (esperado $600, contado $590,
diferencia −$10), existencias 36 / 22 / 9, transferencia RECIBIDA.

## Wybix Owner (emulador, contra la misma nube)

| # | Captura | Qué demuestra |
|---|---|---|
| 30 | tablero-feria | La feria en el tablero: estado y “sincronizó hace X” |
| 31 | eventos | Lista de eventos con base, estado y última sincronización |
| 32 | detalle-evento | Estado por pasos, tablet F1 (contacto, sincronización, versión) |
| 33 | cupo-tablets | Cupo de tablets aplicado con mensaje claro |
| 34 | evento-cerrado | Cerrar evento |
| 35 | conciliar-bloqueado | No concilia con turnos abiertos |
| 36 | personal-evento | Rol por evento (Cajero / Encargado) |

## Mediciones

- `spike-1000.json` (debug), `spike-100-tras-kill.json` (persistencia tras
  matar la app), `spike-release-1000.json` (release).
- `../fase2-idonut-e2e.json`: E2E con SQL Server real de Centro.
