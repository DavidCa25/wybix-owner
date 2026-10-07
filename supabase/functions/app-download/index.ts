/** Descargas públicas. Solo redirige instaladores aprobados; no recibe códigos de vinculación. */
const instaladores: Record<string, string> = {
  owner: 'https://github.com/DavidCa25/wybix-apps/releases/download/android-20261007/Wybix-Owner.apk',
  mobile: 'https://github.com/DavidCa25/wybix-apps/releases/download/android-20261007/Wybix-POS-Mobile.apk',
};
Deno.serve((req: Request) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return Response.json({ error: 'Método no permitido' }, { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
  }
  const app = new URL(req.url).searchParams.get('app');
  const destino = app && Object.hasOwn(instaladores, app) ? instaladores[app] : null;
  if (!destino) return Response.json({ error: 'Selecciona owner o mobile' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  return new Response(null, { status: 302, headers: { Location: destino, 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
});
