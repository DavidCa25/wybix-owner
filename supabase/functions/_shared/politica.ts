// ============================================================================
//  POLÍTICA DE LICENCIAS: la ÚNICA fuente de estos números.
// ----------------------------------------------------------------------------
//  El servidor los escribe DENTRO de cada certificado firmado, y el POS aplica
//  los que trae su certificado. Cambiar la política es cambiar este archivo y
//  volver a emitir certificados: no hay un 45 repetido en cinco lugares.
// ============================================================================

/** Días de prueba gratuita. */
export const TRIAL_DAYS = 30;

/** Días de funcionamiento completo después de que vence la suscripción. */
export const GRACE_DAYS = 45;

/**
 * Días que un certificado vale sin volver a validarse en línea (o importarse
 * un archivo nuevo). Pasado ese plazo el POS sigue VENDIENDO (Venta Esencial)
 * hasta que se refresque: nunca se bloquea el cobro por falta de Internet.
 */
export const OFFLINE_DAYS = 45;

/** Versión del formato del certificado. */
export const SCHEMA = 1;
