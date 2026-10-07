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
  const platform = new URL(req.url).searchParams.get('platform');
  if (platform && !['web','android'].includes(platform)) return Response.json({error:'Plataforma no válida'}, {status:400});
  const agent = req.headers.get('user-agent') ?? '';
  const ios = /iPhone|iPad|iPod/i.test(agent) || (/Macintosh/i.test(agent) && /Mobile\//i.test(agent));
  const web = platform === 'web' || (!platform && ios);
  const location = web ? (app === 'owner' ? 'https://wybix-owner.expo.app' : 'https://wybix-pos-mobile.expo.app') : destino;
  return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store', Vary: 'User-Agent', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
});
