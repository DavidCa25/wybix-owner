// ============================================================
// owner-mfa: recuperar el acceso cuando se perdió el segundo factor.
//
// La persona inició sesión con su contraseña (AAL1) y escribe uno de sus
// códigos de recuperación. Si es válido (SQL: un solo uso, 5 intentos
// fallidos cada 15 min), aquí se quitan TODOS sus factores TOTP y se cierran
// sus OTRAS sesiones; la app la lleva a enrolar un factor nuevo. Para
// administrar sigue necesitando AAL2, así que sin factor nuevo no administra.
//
// Lo que nunca hace: crear sesiones, cambiar contraseñas ni devolver datos.
// ============================================================

export interface DepsOwnerMfa {
  usuarioDeJwt(jwt: string): Promise<{ id: string } | null>;
  rpc(nombre: string, args: Record<string, unknown>): Promise<{ data: any; error: { message: string } | null }>;
  factores(userId: string): Promise<Array<{ id: string }>>;
  borrarFactor(userId: string, factorId: string): Promise<void>;
  cerrarOtrasSesiones(jwt: string): Promise<void>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export async function manejarOwnerMfa(req: Request, d: DepsOwnerMfa): Promise<Response> {
  if (req.method !== 'POST') return json({ ok: false, code: 'METHOD' }, 405);
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ ok: false, code: 'NO_SESSION' }, 401);
  const usuario = await d.usuarioDeJwt(jwt).catch(() => null);
  if (!usuario) return json({ ok: false, code: 'NO_SESSION' }, 401);

  const body = await req.json().catch(() => ({}));
  if (body?.action !== 'recuperar') return json({ ok: false, code: 'BAD_REQUEST' }, 400);
  const codigo = typeof body?.codigo === 'string' ? body.codigo : '';
  if (codigo.replace(/[^A-Za-z0-9]/g, '').length !== 10) return json({ ok: false, code: 'INVALID_CODE' }, 400);

  const r = await d.rpc('mfa_consumir_codigo', { p_user: usuario.id, p_codigo: codigo });
  if (r.error) { console.error('[owner-mfa] rpc', r.error.message); return json({ ok: false, code: 'ERROR' }, 500); }
  if (!r.data?.ok) {
    const code = String(r.data?.code ?? 'INVALID_CODE');
    return json({ ok: false, code }, code === 'RATE_LIMITED' ? 429 : 400);
  }

  // El código ya se gastó: a partir de aquí, si algo falla se informa, no se reintenta con otro código.
  let quitados = 0;
  try {
    for (const f of await d.factores(usuario.id)) { await d.borrarFactor(usuario.id, f.id); quitados++; }
    await d.cerrarOtrasSesiones(jwt);
  } catch (e) {
    console.error('[owner-mfa] quitando factores', e instanceof Error ? e.message : String(e));
    await d.rpc('mfa_recuperacion_completada', { p_user: usuario.id, p_factores_quitados: quitados }).catch(() => undefined);
    return json({ ok: false, code: 'PARTIAL', factores_quitados: quitados }, 500);
  }
  await d.rpc('mfa_recuperacion_completada', { p_user: usuario.id, p_factores_quitados: quitados });
  return json({ ok: true, factores_quitados: quitados });
}
