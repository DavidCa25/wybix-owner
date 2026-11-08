// ============================================================
// Edge Function: club-wallet
// Tarjeta del Club en Apple Wallet y Google Wallet (_shared/club-wallet.ts).
//
//   supabase functions deploy club-wallet --no-verify-jwt
//
// Sin JWT de Supabase porque la llaman Apple (web service de PassKit), el
// teléfono del cliente (enlace) y pg_cron; cada ruta trae su propia prueba:
// credencial del equipo, ApplePass <token>, llave del enlace o WEBHOOK_SECRET.
//
// Secretos (pasos en docs/club-wallet.md):
//   WALLET_SECRET            obligatorio (>= 32): sin él responde 503 a todo.
//   WALLET_PUBLIC_URL        opcional; por omisión SUPABASE_URL/functions/v1/club-wallet.
//   APPLE_PASS_TYPE_ID, APPLE_TEAM_ID, APPLE_PASS_CERT_PEM, APPLE_PASS_KEY_PEM,
//   APPLE_WWDR_PEM           los cinco o Apple queda apagado.
//   GOOGLE_WALLET_ISSUER_ID, GOOGLE_WALLET_SA_JSON   los dos o Google queda apagado.
//   WEBHOOK_SECRET           el ciclo de avisos (pg_cron).
// ============================================================
import { rpcPostgrest, json } from '../_shared/nube.ts';
import { clubWallet, configDesdeEnv, revisarCertApple, type Apns, type ConfigApple } from '../_shared/club-wallet.ts';

const { cfg, falta } = configDesdeEnv((k) => Deno.env.get(k));
if (falta.length) console.warn(`[club-wallet] configuración incompleta: ${falta.join(', ')}`);
if (cfg?.apple) { const p = revisarCertApple(cfg.apple); if (p) { console.error(`[club-wallet] Apple apagado: ${p}`); cfg.apple = null; } }

/* APNs con el MISMO certificado del pase (Wallet no acepta token .p8).
   Un cliente HTTP con certificado de cliente; HTTP/2 lo negocia Deno. */
function apnsCon(a: ConfigApple): Apns {
  let cliente: Deno.HttpClient | null = null;
  return async (token, tema) => {
    cliente ??= Deno.createHttpClient({ cert: a.certPem.replace(/\\n/g, '\n'), key: a.keyPem.replace(/\\n/g, '\n') });
    const r = await fetch(`https://api.push.apple.com/3/device/${encodeURIComponent(token)}`, {
      method: 'POST', client: cliente, headers: { 'apns-topic': tema, 'apns-push-type': 'background', 'apns-priority': '5' }, body: '{}',
      signal: AbortSignal.timeout(10000),
    } as RequestInit & { client: Deno.HttpClient });
    await r.body?.cancel();
    return { status: r.status };
  };
}

const deps = {
  rpc: rpcPostgrest(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),
  fetch, cfg, falta, webhookSecret: Deno.env.get('WEBHOOK_SECRET'),
  apns: cfg?.apple ? apnsCon(cfg.apple) : undefined,
  log: (m: string) => console.log(`[club-wallet] ${m}`),
};

Deno.serve(async (req) => {
  try { return await clubWallet(req, deps); }
  catch (e) { console.error(`[club-wallet] ${(e as Error).message}`); return json({ success: false, error: 'No se pudo atender la tarjeta. Reintenta más tarde.' }, 503); }
});
