# Licenciamiento v2: operación (despliegue, catálogo, precios y claves)

Guía de operación del backend de licencias. El modelo completo está en el POS,
en `docs/licensing.md`. La QA manual de staging está en
`docs/licensing-staging-qa.md` (POS).

---

## 1. Catálogo: la única fuente de verdad comercial

`public.license_catalog` guarda código de producto, edición, giro, periodo de
cobro, precio de lista, precio de referencia, activo/inactivo y entitlements.
Nadie más tiene precios.

| Quién | Qué hace | ¿Tiene precios propios? |
| --- | --- | --- |
| `license_quote()` | Calcula el importe de un pedido (la validación de cobro) | No |
| `license_create_from_order()` | Vuelve a cotizar y exige que lo pagado cubra el total | No |
| Web `/api/license/quote` | Cotiza **antes de pagar**. El checkout cobra en PayPal ESE total; si no hay respuesta, no ofrece pagar. | No |
| Web `scripts/catalogo.mjs` | Copia de lectura para mostrar la página (`prebuild`/`predev`). Sin catálogo, la compilación falla. | No |
| Web `index.html` | Meta y schema.org se llenan al compilar desde esa copia | No |
| Web `api/chat.ts` | Lee el catálogo en vivo; sin catálogo no da cifras | No |
| `license_runtime()` | Entitlements de edición y giro para el certificado | No |

### Cambiar un precio (sin migración)

Un cambio de precio es un **dato comercial**, no un cambio de esquema. Las
migraciones quedan para el esquema, los seeds iniciales y los cambios
estructurales.

```sql
-- precio (NULL = por definir), precio de referencia o activo/inactivo
select license_catalog_update('SUBSCRIPTION_ANNUAL', '{"list_price": 0000}', '<motivo>', 'admin:<quién>');
select license_catalog_update('SCREENS_EXTENDED', '{"active": false}', '<motivo>', 'admin:<quién>');
```

- **Quién puede:** solo el backend privilegiado (`service_role`): la consola
  de Supabase o un futuro endpoint de administración con su propia
  autenticación. Anon y un cliente autenticado **no** pueden (lo prueba H07).
  No hay panel todavía: el día que exista, solo llama a esta función.
- **Motivo y autor:** obligatorios. No se puede poner un precio negativo ni
  tocar el impuesto por aquí.
- **Historial:** `license_catalog_price_history` guarda precio anterior,
  precio nuevo, moneda, `effective_from`, `changed_at`, `changed_by`,
  `reason` y `source`. Lo escribe un **trigger**, así que tampoco se escapa
  un cambio hecho por migración o a mano: queda como `DIRECT`, «sin motivo».
- **Periodos:** `license_catalog_price_periods` responde qué precio tenía
  cada producto, desde cuándo y hasta cuándo.
- **Compras pasadas:** no cambian. Cada fila de `license_purchases` guarda
  su precio de lista, su descuento, lo pagado y la moneda del momento. El
  catálogo solo cotiza operaciones nuevas (lo prueban H04 y WQ2).
- **Efecto:** el cobro usa el precio nuevo **de inmediato**, sin recompilar:
  el checkout cotiza en el servidor. Para que la **página** lo muestre hay
  que volver a compilar la web (un redeploy en Vercel o su *deploy hook*).
  Mientras tanto, el checkout avisa «El precio se actualizó» y cobra el
  correcto.

**Precios vigentes, sin cambios:** MonoCaja $2,499, MultiCaja $3,999, soporte
prioritario $690 (referencia $890), app adicional $600, timbres ($250 /
$890 / $1,490 / $3,990 / $5,900) y capacitación $300.

**Siguen en `NULL`** (no se pueden cobrar): giro adicional, pantallas 10 o
ilimitadas, suscripción mensual y anual, y MultiSucursal.

---

## 2. Despliegue en dos pasos (expandir → contraer)

- **PARTE A** (`20260926120000_licenciamiento_v2.sql`) solo agrega. No toca
  `max_registers` (lo siguen escribiendo y leyendo la web y el
  `license-check` anteriores); las cajas salen de la edición.
- **PARTE B** (`20260927120000_licenciamiento_v2_final.sql`) normaliza
  (MultiCaja = NULL) y agrega las restricciones.

### Orden

1. Ceremonia de la clave de producción (sección 3) y secretos en Supabase.
   La pública se pega en `PRODUCCION` del POS.
2. **PARTE A.**
3. `license-check`, `trial-license` y `pos-sync`.
4. **Web nueva** (con `SUPABASE_URL`, `SUPABASE_ANON_KEY` y
   `SUPABASE_SERVICE_ROLE_KEY` en Vercel). Verificarla en staging antes:
   `docs/licensing-staging-qa.md`.
5. **Clasificar y reemitir las 7 licencias** (sección 4).
6. **POS nuevo**. Exige certificado firmado: una licencia sin firma pide
   «actualizarse».
7. Verificar: `select count(*) from licenses where created_at > '<despliegue de la web>' and origin is null;` debe dar **0**.
8. **PARTE B.**
9. Rotar el JWT secret del proyecto (el service role de las cajas
   anteriores).

Hasta el paso 7 se vuelve atrás sin tocar datos.

`node scripts/probar-licenciamiento.mjs` recorre todo este orden: 120
pruebas, incluidas la web anterior y la nueva por HTTP contra la transición
y el estado final, la cotización antes de pagar y la reemisión de las 7.

---

## 3. Claves de firma y KIDs

ES256 (P-256). Firma el servidor; el POS solo verifica.

### Dónde vive cada clave

| Clave | Dónde | Dónde NO |
| --- | --- | --- |
| Privada de **producción** | Solo `LICENSE_SIGNING_KEY` en el gestor de secretos de Supabase, más su respaldo (abajo) | Git, `.env` commiteado, el POS, el asar, Angular, variables `VITE_*`, logs, documentación |
| Privada de **desarrollo** (`wybix-dev-N`) | `.secrets/` de wybix-owner (en `.gitignore`) | Supabase de producción |
| Privada de **QA/E2E** | Efímera: la genera el arnés en cada corrida (`e2e/perfil.js`) | Cualquier archivo |
| **Públicas** | `electron/licencia/llaves-publicas.js` (POS) y `LICENSE_PUBLIC_KEYS` (Supabase) | No son secretas |

El POS empaquetado confía **solo** en `PRODUCCION`:

- Desarrollo solo se acepta sin empaquetar.
- QA solo con `WYBIX_E2E=1` y sin empaquetar.
- Un certificado firmado con `wybix-dev-N` dentro del instalador se rechaza
  (lo prueba `test:licencia-v2`).
- `npm run dist`, `pack` y `publish` se detienen si `PRODUCCION` está vacío
  o trae una clave de desarrollo.

### Secretos

| Secreto | Contenido |
| --- | --- |
| `LICENSE_SIGNING_KEY` | PKCS8 PEM de la privada activa |
| `LICENSE_SIGNING_KID` | Su KID (`wybix-lic-N`), **obligatorio** |
| `LICENSE_PUBLIC_KEYS` | JSON `{ "wybix-lic-1": "<PEM>", ... }` con todas las públicas vigentes |
| `LICENSE_REVOKED_KIDS` | KIDs comprometidos, separados por coma |

Antes de firmar, el servidor se autocomprueba: su privada contra
`LICENSE_PUBLIC_KEYS[KID]`. Si no coinciden, no firma y registra solo el
motivo. Tampoco firma con un KID revocado.

### Generación (ceremonia)

```
node scripts/generar-llaves-licencia.mjs --produccion --kid wybix-lic-N --salida <carpeta fuera de cualquier repo>
```

- Se niega dentro de un repositorio.
- Escribe la privada con permisos 0600 y no la imprime.
- Imprime la pública y su huella SHA-256.

Se hace en un equipo de confianza, idealmente con dos personas presentes.

### Respaldo de la privada de producción

1. **Copia primaria:** en el gestor de contraseñas de la empresa, como nota
   segura en una bóveda de acceso restringido (solo el dueño y una persona
   de respaldo), con autenticación de dos factores.
2. **Copia fuera de línea:** en una memoria USB **cifrada** (VeraCrypt o
   BitLocker To Go) con una frase de paso distinta. Guardarla en un lugar
   físico distinto de la oficina (caja fuerte o notaría).
3. **Nunca** en el mismo servidor sin otra copia, en Git, en correo ni en un
   chat.
4. **Recuperación:** se recupera desde la bóveda y se vuelve a cargar con
   `supabase secrets set`. Probarlo una vez al año en **staging** (firmar un
   certificado y verificarlo con la pública publicada), sin exponer la clave
   de producción.
5. Anotar en `license_events` (o en la bitácora de la empresa) cada vez que
   alguien accede a la copia.

### Cómo conoce el POS un KID nuevo

**Hoy, solo actualizándose.** Las públicas en las que confía un POS son las
que trae su versión (`PRODUCCION` en `llaves-publicas.js`); no las descarga.
Un POS que conoce KID 1 **no** puede verificar un certificado firmado con
KID 2.

Si el servidor empezara a firmar con KID 2 antes de que los POS lo conozcan:

- sus refrescos fallarían la verificación;
- se quedarían con el certificado anterior hasta que venza su validez sin
  red (45 días);
- después pasarían a Venta Esencial.

Por eso **el orden es obligatorio**.

### Rotación planeada (KID 1 → KID 2)

1. Generar `wybix-lic-2` en la ceremonia. Respaldarla.
2. **Publicar un POS que confíe en KID 1 + KID 2** (las dos en
   `PRODUCCION`).
3. **Esperar adopción suficiente:** que los equipos activos se hayan
   actualizado. Hoy el POS **no reporta su versión** al refrescar, así que se
   espera un ciclo de actualización completo. Deuda: mandar la versión en
   `validate` para medirlo.
4. `LICENSE_PUBLIC_KEYS` con 1 y 2. **Cambiar el firmante activo**:
   `LICENSE_SIGNING_KEY`/`KID` → 2.
5. **Seguir aceptando KID 1:** los certificados existentes siguen
   verificando. Cada equipo recibe uno KID 2 en su siguiente refresco.
6. **Retirar KID 1** en una versión posterior del POS y de
   `LICENSE_PUBLIC_KEYS`, cuando hayan pasado al menos 45 días desde el paso
   4. Un equipo que aún tuviera un certificado KID 1 no se queda sin opción:
   queda `TAMPER / clave-desconocida` y «Actualizar licencia» se lo cambia.
7. Destruir las copias de la privada de KID 1 cuando ya no firme nada.

### KID revocado: monotónico

- Un certificado nuevo trae `revoked_kids`. El POS lo guarda en
  `licencia-kids-revocados.json`, **aparte de la licencia**.
- Solo crece: liberar el equipo, borrar la licencia o importar un archivo
  viejo **no** lo quita, y no existe operación que quite un KID.
- Desde ese momento no acepta nada firmado con ese KID, nuevo ni viejo.
- Una versión del POS puede traerlo de fábrica (`REVOCADAS`).

Probado en `test:licencia-v2`: revocar, liberar el equipo, reiniciar e
importar un archivo viejo sigue rechazado.

### Runbook: la privada de KID 1 se filtró

**No** imprimir ni pegar claves en tickets, chats ni logs durante el
incidente.

1. **Generar KID 2** en la ceremonia y respaldarla.
2. **Distribuir la confianza en KID 2:** publicar de inmediato un POS con
   KID 2 en `PRODUCCION` y KID 1 en `REVOCADAS`.
3. **Marcar KID 1 comprometido:** `LICENSE_REVOKED_KIDS=wybix-lic-1` y
   `LICENSE_PUBLIC_KEYS` con KID 2.
4. **Emitir la revocación:** cambiar el firmante a KID 2. Cada certificado
   nuevo lleva `revoked_kids: ["wybix-lic-1"]`, y cualquier POS que lo
   reciba deja de aceptar KID 1 para siempre, aunque no se haya actualizado.
5. **Refrescar clientes:**
   - los POS refrescan solos a diario;
   - los que no tengan Internet, con el archivo de `/licencia`;
   - avisar a los clientes activos que conecten el equipo o actualicen.
6. **Dejar de firmar con KID 1:** ya ocurrió en el paso 4. El servidor
   rechaza firmar con un KID revocado y deja de aceptar certificados KID 1
   para liberar equipos.
7. **Revisar licencias sospechosas:**
   - `license_events` y `license_activations` del periodo expuesto:
     activaciones inusuales, equipos nuevos, descargas de certificado
     (`CERTIFICATE_DOWNLOADED`);
   - suspender (`status = 'suspendida'`) lo que no corresponda a una compra
     en `license_purchases`.
8. **Retirar KID 1** de `LICENSE_PUBLIC_KEYS` y del POS cuando todos los
   equipos activos tengan certificado KID 2. Destruir las copias de la
   privada filtrada.

### Mejora futura (NO implementada): keyset firmado por una raíz

Para distribuir públicas nuevas sin actualizar el POS:

- una **raíz Wybix** (clave offline, casi nunca usada) cuya pública trae el
  POS de fábrica;
- la raíz **firma un keyset** (`{ kids: {...}, revoked: [...], version }`);
- el servidor lo sirve junto al certificado, y el POS acepta KIDs nuevos si
  el keyset verifica con la raíz y su versión es mayor que la que conoce;
- la rotación dejaría de depender de publicar un POS.

Queda fuera de V2: hoy basta publicar el POS antes de rotar.

---

## 4. Las 7 licencias existentes

Auditoría de producción de solo lectura (2026-09-26). Ninguna es de un
cliente.

| id | clave | qué es | origen | ¿se reemite? | acción |
| --- | --- | --- | --- | --- | --- |
| 81666a44 | WYBX-M…4PKH | VM de desarrollo en uso (2026-09-26) | **QA** | Sí: V2 firmado, tres giros y pantallas ilimitadas explícitos | Mantener |
| 7484b07f | WYBX-M…UU7X | QA MultiCaja, 2 equipos | **QA** | Sí: V2 firmado, MultiCaja, tres giros con cuota normal | Mantener |
| b4a22322 | WYBIX-…5UE6 | Compra del dueño por PayPal, nunca activada | **INTERNAL** | No (sin equipo); sin giros hasta decidir | Confirmar si el pago fue sandbox o live |
| 8bf0ca6a | WYBX-M…V332 | Prueba VM MultiCaja, último uso 09-09 | TEST | Solo si refresca: V2 sin giros | **Candidata a cancelar** |
| 94aac9c6 | WYBX-M…SMBM | Prueba VM, sin uso desde 07-10 | TEST | Solo si refresca: V2 sin giros | **Candidata a cancelar** |
| 14151809 | WYBX-M…E8FH | Prueba VM, equipo liberado | TEST | Solo si refresca: V2 sin giros | **Candidata a cancelar** |
| 3db46dcb | WYBX-M…6AJY | Prueba VM, equipo liberado | TEST | Solo si refresca: V2 sin giros | **Candidata a cancelar** |

**Cómo se aplica:** `supabase/data/2026-09-26_clasificar-licencias-existentes.sql`.

- Termina en `ROLLBACK`; se revisa y se cambia a `COMMIT` a propósito.
- Probado sobre una réplica: pruebas CL0 a CL4.
- **No se ha ejecutado en producción.**

Qué hace:

- fija el origen;
- da permisos QA explícitos con `license_qa_grant` (que rechaza una licencia
  `PRODUCTION`);
- marca candidatas con `license_mark_cancel_candidate`.

No borra ni suspende.

**Reemitir** no requiere tocar los equipos. Al siguiente refresco, o con
«Actualizar licencia», cada VM recibe su certificado V2 firmado con la clave
de producción. Una licencia sin firma ya no se acepta en el POS nuevo.

**Separación comercial:**

- `license_commercial_licenses` y `license_commercial_purchases` solo ven
  `PRODUCTION`: son la única fuente para contar clientes, ventas de
  licencias, renovaciones o MRR.
- No hay renovaciones automáticas en V2.

---

## 5. Prueba gratuita

- 30 días de MonoCaja con el giro elegido en el alta y 3 Pantallas
  Operativas de ese giro.
- Antes de elegir: solo la edición. Nunca los tres giros.
- `trial-license select_vertical`: uno a la vez, solo con la prueba vigente,
  sin mover fechas y con historial.
