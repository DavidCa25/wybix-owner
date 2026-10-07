# Mobile actual frente al backend remoto

Proyecto: `swlpspgmkwzlrowllvvj`, actualizado el 5 de octubre de 2026. Backend Fase 1/2/3 aplicado, catorce versiones registradas y once funciones actualizadas. Smoke positivo realizado a través de la ruta pública de la landing con dos empresas QA nuevas; las cinco licencias antiguas sin empresa quedan excluidas.

| Componente Mobile | Contrato backend requerido | Disponible remoto | Evidencia |
|---|---|---|---|
| Enrolamiento | `enroll` → `pos_enroll`, devices/registers/entitlements, kind MOBILE_POS | SÍ | PASS real; código consumido no reutilizable |
| Login/PIN | Snapshot staff, rol por evento, hashes y bloqueo SQLite | SÍ | Snapshot remoto aplicado a SQLite; PIN QA validado |
| Snapshot | `mobile_snapshot`, catalog_publications/personal/caja | SÍ | PASS catálogo y personal por evento |
| Turnos | SHIFT events → sync_ingest/shift_facts | SÍ | Apertura/cierre QA proyectados |
| Ventas | SALE events → sales_facts/sale_line_facts | SÍ | Una venta QA tras envío y repetición |
| Sync/outbox | events, sync_ingest, device scope/idempotencia | SÍ | Outbox cero; sin rechazo/cuarentena ni duplicados |
| Inbox/latido | mobile_inbox/mobile_heartbeat/app_releases | SÍ | Motor completo remoto PASS |
| Rechazo/cuarentena | Respuesta por event_uuid y auditoría; local conserva estado | SÍ | Contratos/grants smoke; casos detallados locales |
| Impresión | Ticket y print_jobs SQLite; LAN/Android fuera de transacción | SÍ, sin RPC propia | Backend venta PASS; hardware pendiente |
| Remote approvals | approval_request/status/consume/cancel → aprobacion_* | SÍ | PENDING/status/CANCELLED; scope ajeno y consumo prematuro negados; decisión Owner AAL2 pendiente |
| Business date | Fecha de turno, validación de drift en proyección | SÍ | Venta/cierre QA aceptados; límites de fecha locales |
| Reconciliación | Owner owner_evento_estado/evento_cambiar_estado, ledger y desglose | SÍ | Smoke contratos/grants y SQL local; piloto Owner pendiente |
| Background | Mismo events/snapshot/inbox/latido, worker headless cifrado | SÍ | Backend completo PASS; prueba física del nuevo APK pendiente |

Owner dispone remotamente de membresías, eventos/personal/dispositivos, RPCs MFA, recuperación owner-mfa, preferencias/avisos y aprobaciones. Los smokes verifican cuerpos/permisos; las rutas sin sesión rechazan con 401. Esto no certifica Auth TOTP, decisión Owner AAL2 o recepción push/email físicos. Cron está apagado hasta verificar proveedor/remitente y recepción. La app Owner antigua no verificada sigue necesitando evidencia para conciliarla.

Comprobación adicional remota: Supabase Auth enroló/verificó TOTP para una cuenta sintética QA; AAL1 no pudo decidir, AAL2 aprobó y la tablet consumió una vez. Código de recuperación Edge consumido una vez y factores QA retirados: PASS, 20 controles. Esta prueba verifica el protocolo real; UI/autenticador físicos y recepción siguen pendientes. El APK interno final pasó firma/certificado/runtime, y la tablet virtual sincronizada fue revocada con Owner AAL2 para liberar el cupo del piloto físico.

## Licencia decidida

**Opción D: múltiples escenarios.** Flujo integral con licencia `origin=QA`, edición `multi`, giro COMMERCE, `screen_tier=BASE`, addon `MOBILE_POS`, vigencia QA elegida de 14 días. Una segunda empresa QA independiente con su propia licencia sirve para pruebas de scope/dispositivo ajeno. Demo Manager sirve para probar aislamiento Windows, no para sustituir enrolamiento Mobile. Trial no habilita Mobile/eventos según los grants remotos consultados; no es la licencia del piloto integral.

Fuente comercial: `license_catalog`. Remoto: MonoCaja = registers_max 1; MultiCaja = registers_max null; ambos tienen sales/customers/reports/invoicing/loyalty/inventory/purchases/suppliers/cloud_sync/backup. COMMERCE agrega commerce/operational_surfaces/operational.inventory_floor y BASE da 3 pantallas del giro. `EXTRA_APP_MOBILE` es app de monitoreo adicional, grants vacíos; NO es Wybix POS Mobile.

La Fase 2 local agrega `ADDON_MOBILE_POS`: mobile_pos true, mobile_pos_max 1, temporary_locations true, entitlements mobile_pos/temporary_locations. Su precio/billing son null: no inventar compra ni precio. El grant de edición da una sucursal base por licencia; EVENT no consume otra BRANCH. MultiCaja no habilita por sí sola varias tablets ni MultiSucursal.

`license_qa_grant` permite edición/giros/pantallas/vigencia solo a origin QA/TEST/INTERNAL y exige motivo/actor. No agrega el addon automáticamente: este debe estar en licenses.addons, tras aplicar la restricción Fase 2. El fixture anterior de I Do Nut y la empresa sintética local son evidencia técnica; no se reutilizan datos reales ni credenciales en el piloto.

La política versionada de trial usa 30 días; la duración exacta del bundle remoto no se certificó solo por su número de versión. La elección del piloto se apoya en grants realmente consultados, no en aquella duración histórica. `company_entitlements` debe comprobarse después del vínculo POS/licencia antes de enrolar.
