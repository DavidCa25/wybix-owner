# 1. Veredicto

**BACKEND Y APK FIRMADO LISTOS PARA PILOTO FÍSICO.** Al 5 de octubre están instaladas Fases 1/2/3, el historial tiene catorce versiones y las once Edge Functions del delta están verificadas. El APK interno terminó y su firma coincide con la llave definitiva. MFA/TOTP, aprobaciones AAL2 y recuperación Edge reales pasaron con una cuenta sintética. Cron permanece apagado hasta verificar proveedor/remitente y recepción. No declarar la fase cerrada antes del piloto físico.

# 2. Backend

Proyecto swlpspgmkwzlrowllvvj. Backup lógico restaurado y verificado: 55 tablas/8783 filas. Baseline y Fase 1 verificados previamente; las nueve etapas nuevas se ensayaron con pg_cron real en un contenedor aislado sin red y luego se aplicaron individualmente en remoto, con smoke antes de registrar historial. Las catorce versiones están registradas; 60 tablas/vistas públicas. Se corrigieron grants heredados en location_stock y helpers internos, y el cron se instala inactivo.

Once funciones actualizadas, ACTIVE, código descargado coincidente y rechazo sin identidad comprobado. WEBHOOK_SECRET rotado y tres referencias Vault configuradas; rechazo sin secreto 401. license-check, trial-license y fiscal-catalogs se preservaron. No se activó FISCAL_PERMITIR_LEGADO ni se hicieron operaciones fiscales con datos reales.

El propietario excluyó las cinco licencias antiguas de prueba sin empresa: permanecen sin vincular ni borrar. El piloto usa dos licencias origin=QA nuevas previstas en la guía, con Mobile efectivo, vigencia de 14 días y empresas aisladas. Smoke por la URL pública: enrolamiento, código de un uso, snapshot, PIN local, scope ajeno, venta/turno/cierre, sync e idempotencia PASS. Solicitud/consulta/cancelación de aprobación PASS; consumo prematuro y empresa ajena negados. Decisión Owner AAL2 física pendiente.

# 3. Release

El propietario confirmó EAS y APK productivo previos. Configuración production-apk/internal, remote credentials, pos-production, SDK 54, com.wybix.posmobile. Certificado remoto comparado con JKS definitivo: huella SHA-256 coincidente, sin regeneración. El primer build falló por rutas Windows en Fingerprint y plataformas implícitas distintas; se corrigió conservando la política fingerprint. Segundo build 20b1a630-2a35-475f-ab52-2e78ab7b97ce FINISHED. APK 120465293 bytes, firma v2 PASS, certificado definitivo coincidente, minSdk 24, target 36, cuatro ABI. Runtime incorporado 6895f7b5917621db7e90e2fb8f79c7a45ee1e915 idéntico a EAS; perfil produccion, canal y backend correctos. RELEASE-EAS.md conserva hash y controles. Fuente enviada con cambios de trabajo: no se hizo un cuarto commit ni push.

MFA real remoto: 20 comprobaciones PASS, incluidas TOTP, AAL1 denegado, decisión AAL2, payload alterado/empresa ajena denegados, consumo único, recovery codes y owner-mfa con recuperación de un uso. El piloto dispone de código de enrolamiento nuevo y acceso QA privado; el equipo virtual fue revocado con AAL2 para liberar cupo, sin borrar sus hechos. Validación visual Owner/autenticador y actualización firmada pendientes.

# 4. Pruebas automáticas

| Comando / campaña | Resultado | Vigencia |
|---|---|---|
| npm run test:full | PASS: TypeScript, Node 94/94, SQL 75/75 | Esta sesión; qa/full.json |
| Ensayo sobre backup + nueve etapas + repetición | PASS con pg_cron y grants por defecto de Supabase | Evidencia protegida; cron inactivo |
| Backend público Mobile + SQLite | PASS venta/turno/cierre y repetición única; aislamiento | Dos empresas QA nuevas; sin datos de clientes |
| Aprobaciones remotas desde tablet QA | PASS solicitud/estado/cancelación, scope y consumo prematuro | Decisión física Owner AAL2 pendiente |
| MFA/TOTP y recuperación Edge remotos | PASS 20 controles con identidad QA real de Supabase Auth | Incluye decisión AAL2 y consumo único; UI física pendiente |
| APK EAS interno y firma final | FINISHED; firma v2/certificado/hash/runtime/package PASS | Build 20b1a630; Android 7+; piloto preparado |
| Ocho migraciones F3 aplicadas dos veces | PASS | Incluido en full |
| Script licencias QA local | PASS creación, grants efectivos, rechazo duplicado y transacción rollback | Esta sesión; manual-estructura.json |
| MFA GoTrue/TOTP/Edge local | PASS 15/15 | Relevo previo; no repetido sin cambio |
| Android aprobación Owner AAL2 → tablet | CONSUMED, un movimiento | Evidencia previa android/aprobacion.json |
| Android proceso cerrado, worker headless | Cloud 2 → 3 → 3 al repetir | Evidencia previa android/background.json |
| APK local x86_64 desarrollo | Compilado e instalado | Evidencia previa android/apk.json; no productivo |
| Windows SQL persistente / cortes-outbox | PASS 29/29 | Relevo previo, mismos archivos |
| Demo Manager aislado | PASS 73/73 | Relevo previo |
| db:test-giros | Resultado en cierre-giros.json | Campaña aislada de esta sesión |

Las pruebas no sembraron datos remotos ni ejecutaron suites destructivas sobre bases reales. La guarda demo compara identidad/fecha de bases; no constituye backup ni comparación de cada fila.

# 5. Pruebas manuales

PRUEBAS-MANUALES-CIERRE-FASE3.md: 31 casos, pasos 0–21, siete campos por caso y matriz final, todos PENDIENTES. **Opción D:** dos empresas/licencias QA multi + COMMERCE/BASE + MOBILE_POS (14 días elegidos para QA), más Demo Windows para aislamiento. Trial y EXTRA_APP_MOBILE no habilitan por sí solos POS Mobile/eventos. PIN son placeholders privados.

# 6. Hardware

Emulador Android y diálogos/servicios locales validados. Impresora LAN física, teléfono Owner push, scheduler sin aceleración, batería/Doze/reinicio y actualización firmada: **IMPLEMENTADO / VALIDACIÓN FÍSICA PENDIENTE**. Email exige recepción comprobada con proveedor/buzón real. Corte ciego incluye prueba de inferencia desde otras pantallas; todavía no se certifica ese resultado manual.

# 7. Design system

fase3-design-system-consolidacion.md actualizado con accessibilityLabel y contratos operativos. Astra debe decidir tipografía, paleta, composición y consolidación final; no se unificó estética en este cierre. Gate independiente del backend.

# 8. Fuera de alcance

Bluetooth: FUERA DE ALCANCE ACTUAL. Mercado Pago: MANUAL / FUERA DE INTEGRACIÓN DIRECTA.

# 9. Commits y alcance

Owner y Mobile comparten repositorio. 4151f27 `feat(phase3): integrate Owner security and POS Mobile operations`: incorpora reorganización necesaria, paquetes, backend, Mobile, MFA/notificaciones/aprobaciones y harness. Validación: test:full y pruebas nativas/MFA previas, coherentes con código actual.

8047fa5 `docs(phase3): prepare staged deployment and reproducible release QA`: documentación, conceptos fuente y evidencia JSON depurada; guía estructural validada. El commit final agrega este cierre y resultado de giros. Máximo tres commits en este repositorio; Windows tiene un commit del harness, registrado en cierre-giros.json.

Windows conserva deliberadamente cambios previos de Fase 2 (cloud/catalogo/transferencias/UI) fuera del commit de QA. Owner conserva cambios/evidencia histórica Fase 1/2 no incluidos: fase1-idonut-resumen.json, fase2-idonut-e2e.json, recibo LAN y métricas spike. No se borraron datos para forzar un working tree limpio. Landing sin cambios de esta solicitud. Logs/capturas sensibles/builds/llaves/scratch fuera de commits. Sin push ni publicación.

# 10. Acciones pendientes del propietario

La autorización para continuar los siguientes pasos ya se recibió y las migraciones/funciones/Vault se ejecutaron. No volver a pedir autorización para acciones ya cubiertas. Las cinco licencias excluidas quedan fuera del cierre y no se asignan a una empresa.

Faltan clave local Resend y remitente verificado, recepción push/email, interacción física Owner/autenticador, evidencia para conciliar la app Owner antigua, impresión/Doze y actualización. Auth TOTP/decisión AAL2/recuperación y firma del APK ya pasaron. Si hay POS fiscales anteriores, decidir la transición por scope antes de liberarlos; no habilitar legado automáticamente. En futuras fases las migraciones se desarrollan y validan junto con sus contratos, según AGENTS.md. Publicación/store y push Git quedan fuera de esta ejecución.
