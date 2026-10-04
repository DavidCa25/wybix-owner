# Mobile actual frente al backend remoto

Proyecto consultado: `swlpspgmkwzlrowllvvj`, 4 de octubre de 2026. La evidencia actual tiene prioridad sobre el historial documental. No se construirá un APK productivo antes de pasar los contratos requeridos.

| Componente Mobile | Contrato backend requerido | Disponible remoto | Evidencia |
|---|---|---|---|
| Enrolamiento | `enroll` → `pos_enroll`, devices/registers/entitlements, kind MOBILE_POS | NO | pos-sync v1; devices/registers ausentes |
| Login/PIN | Snapshot staff, rol por evento, hashes y bloqueo SQLite | Local sí; provisión remota NO | Auth/local tests; employees/location_staff ausentes |
| Snapshot | `mobile_snapshot`, catalog_publications/personal/caja | NO | RPC/tablas ausentes |
| Turnos | SHIFT events → sync_ingest/shift_facts | NO | Hechos/RPC ausentes |
| Ventas | SALE events → sales_facts/sale_line_facts | NO | Tablas ausentes |
| Sync/outbox | events, sync_ingest, device scope/idempotencia | NO | sync_events/dispositivos ausentes; outbox es local |
| Inbox/latido | mobile_inbox/mobile_heartbeat/app_releases | NO | RPC/tablas ausentes |
| Rechazo/cuarentena | Respuesta por event_uuid y auditoría; local conserva estado | NO | Nuevo ingest ausente |
| Impresión | Ticket y print_jobs SQLite; LAN/Android fuera de transacción | Sin RPC propia; ventas requeridas NO | Pruebas locales y diálogo Android |
| Remote approvals | approval_request/status/consume/cancel → aprobacion_* | NO | approval_requests/policies/RPCs ausentes |
| Business date | Fecha de turno, validación de drift en proyección | NO | Nuevo ingest/shift_facts ausentes |
| Reconciliación | Owner owner_evento_estado/evento_cambiar_estado, ledger y desglose | NO | RPC/tablas ausentes |
| Background | Mismo events/snapshot/inbox/latido, worker headless cifrado | Local sí; backend remoto NO | Caso con proceso cerrado local y faltantes anteriores |

Owner requiere además membresías, eventos/personal/dispositivos, `mfa_estado`, `mfa_generar_codigos`, `mfa_registrar`, recuperación owner-mfa, preferencias/avisos y owner_aprobaciones/owner_decidir_aprobacion. El inventario remoto no tiene estos contratos. La presencia del antiguo link-owner no demuestra membresías/invitaciones seguras.

## Licencia decidida

**Opción D: múltiples escenarios.** Flujo integral con licencia `origin=QA`, edición `multi`, giro COMMERCE, `screen_tier=BASE`, addon `MOBILE_POS`, vigencia QA elegida de 14 días. Una segunda empresa QA independiente con su propia licencia sirve para pruebas de scope/dispositivo ajeno. Demo Manager sirve para probar aislamiento Windows, no para sustituir enrolamiento Mobile. Trial no habilita Mobile/eventos según los grants remotos consultados; no es la licencia del piloto integral.

Fuente comercial: `license_catalog`. Remoto: MonoCaja = registers_max 1; MultiCaja = registers_max null; ambos tienen sales/customers/reports/invoicing/loyalty/inventory/purchases/suppliers/cloud_sync/backup. COMMERCE agrega commerce/operational_surfaces/operational.inventory_floor y BASE da 3 pantallas del giro. `EXTRA_APP_MOBILE` es app de monitoreo adicional, grants vacíos; NO es Wybix POS Mobile.

La Fase 2 local agrega `ADDON_MOBILE_POS`: mobile_pos true, mobile_pos_max 1, temporary_locations true, entitlements mobile_pos/temporary_locations. Su precio/billing son null: no inventar compra ni precio. El grant de edición da una sucursal base por licencia; EVENT no consume otra BRANCH. MultiCaja no habilita por sí sola varias tablets ni MultiSucursal.

`license_qa_grant` permite edición/giros/pantallas/vigencia solo a origin QA/TEST/INTERNAL y exige motivo/actor. No agrega el addon automáticamente: este debe estar en licenses.addons, tras aplicar la restricción Fase 2. El fixture anterior de I Do Nut y la empresa sintética local son evidencia técnica; no se reutilizan datos reales ni credenciales en el piloto.

La política versionada de trial usa 30 días; la duración exacta del bundle remoto no se certificó solo por su número de versión. La elección del piloto se apoya en grants realmente consultados, no en aquella duración histórica. `company_entitlements` debe comprobarse después del vínculo POS/licencia antes de enrolar.
