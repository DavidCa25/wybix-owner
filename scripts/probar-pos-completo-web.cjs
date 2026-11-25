// Recorrido Chromium real de POS Mobile (auditoría 2026-11-24): paquetes y
// búsqueda sin acentos, código por lector, cobro dividido, devolución y conteo.
// Base local con bóveda temporal; NO se conecta a la nube ni usa credenciales reales.
//
//   npm run build:pwa:pos
//   PLAYWRIGHT_MODULE=… ESBUILD_MODULE=… node scripts/probar-pos-completo-web.cjs
//
// Deja capturas en docs/evidencia/pos-completo/ (WYBIX_QA_CAPTURAS=0 para no).
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const esbuild=require(process.env.ESBUILD_MODULE||require.resolve('esbuild',{paths:[process.cwd(),path.resolve('../..','filtros_lubs_rios')]}));
const origin='http://127.0.0.1:6179',dist=path.resolve('apps/pos-mobile/dist');
const capturas=process.env.WYBIX_QA_CAPTURAS==='0'?null:path.resolve('docs/evidencia/pos-completo');
(async()=>{
 const {snapshot,U,PIN}=await import('../packages/database/test/fixture.ts');
 const sample=snapshot();
 const dona=sample.catalog.products.find(p=>p.uuid===U.dona);
 dona.bar_code='7500000000011';dona.part_number='DONA-GLA';
 dona.presentations=[{id:'6',name:'Caja 6',factor:6,sale_price:'130.00',bar_code:'7500000000066'},{id:'12',name:'Caja 12',factor:12,sale_price:'250.00',bar_code:'7500000000127'}];
 const entry=`import {baseWeb,ARCHIVO} from './apps/pos-mobile/lib/base.web.ts';import {readVault,writeVault,writeText} from './apps/pos-mobile/lib/web-vault.ts';import {migrar,guardarEnrolamiento,aplicarSnapshot,crearPos} from '@wybix/database';
 async function open(initial){const SQL=await globalThis.initSqlJs({locateFile:n=>'/sqlite/'+n});return baseWeb(SQL,initial,b=>writeVault(ARCHIVO,b));}
 globalThis.qaSeed=async s=>{const db=await open(null);await migrar(db);await guardarEnrolamiento(db,{device_uuid:'tablet-1',device_id:'dev-1'});await aplicarSnapshot(db,s);const p=crearPos(db);const supervisor={uuid:s.staff[1].uuid,name:'marta',role:'SUPERVISOR'};await p.recibirTransferencia(supervisor,s.transfers[0].transfer_uuid,{});await p.abrirTurno(supervisor,'100');await writeText('device_token','qa-sin-acceso-a-la-nube');await writeText('device_uuid','tablet-1');};
 globalThis.qaRead=async()=>{const db=await open(await readVault(ARCHIVO));return {sales:await db.all('SELECT folio,total,refunded_total,status FROM sales ORDER BY folio'),payments:await db.all('SELECT sale_uuid,method,amount FROM payments ORDER BY sale_uuid,seq'),stock:await db.all('SELECT product_uuid,qty FROM stock_projection'),cash:await db.all('SELECT type,amount FROM cash_movements'),events:await db.all('SELECT event_type FROM outbox')};};`;
 const bundle=(await esbuild.build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',format:'iife',write:false,target:'es2022'})).outputFiles[0].text;
 let server=http.createServer((req,res)=>{const url=new URL(req.url,origin);if(url.pathname==='/qa-empty'){res.end('<html><body>QA aislado</body></html>');return;}let f=path.resolve(dist,'.'+decodeURIComponent(url.pathname));if(!f.startsWith(dist+path.sep)&&f!==dist){res.writeHead(403);res.end();return;}if(!fs.existsSync(f)||fs.statSync(f).isDirectory())f=path.join(dist,'index.html');res.setHeader('Content-Type',({'.js':'application/javascript','.wasm':'application/wasm','.html':'text/html','.json':'application/json','.ttf':'font/ttf','.png':'image/png'})[path.extname(f)]||'application/octet-stream');fs.createReadStream(f).pipe(res);});
 let browser,context,page;const foto=async n=>{if(capturas){fs.mkdirSync(capturas,{recursive:true});await page.screenshot({path:path.join(capturas,n+'.png')});}};
 try{
  await new Promise(resolve=>server.listen(6179,'127.0.0.1',resolve));browser=await chromium.launch({headless:true});context=await browser.newContext({viewport:{width:1280,height:800}});page=await context.newPage();const errors=[];
  await page.addInitScript(()=>{const original=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input.url,location.origin);if(url.origin!==location.origin)return Promise.reject(new TypeError('QA sin conexión externa'));return original(input,init);};});
  page.on('pageerror',e=>errors.push(e.message));await context.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
  await page.goto(origin+'/qa-empty');await page.addScriptTag({url:'/sqlite/sql-wasm.js'});await page.addScriptTag({content:bundle});await page.evaluate(s=>qaSeed(s),sample);await page.goto(origin);
  await page.getByTestId('persona-marta').click();for(const digit of PIN.marta)await page.getByRole('button',{name:digit,exact:true}).click();await page.getByTestId('entrar').click();await page.getByTestId('producto-Dona glaseada').waitFor();

  // 1. Buscar sin acentos: «cafe» encuentra «Café de olla»; «dona caja» trae los paquetes de menor a mayor.
  const buscar=page.getByLabel('Buscar producto por nombre, clave o código');
  await buscar.fill('cafe');await page.getByTestId('producto-Café de olla').waitFor();
  await buscar.fill('dona caja');await page.getByTestId('producto-Dona glaseada · Caja 6').waitFor();
  const orden=await page.locator('[data-testid^="producto-Dona glaseada · Caja"]').evaluateAll(xs=>xs.map(x=>x.getAttribute('data-testid')));
  assert.deepEqual(orden,['producto-Dona glaseada · Caja 6','producto-Dona glaseada · Caja 12']);
  await foto('1-buscar-paquetes');
  await page.getByTestId('producto-Dona glaseada · Caja 6').click();
  // 2. Lector de código (teclea y da Enter): la caja de 12 entra completa.
  await buscar.fill('7500000000127');await buscar.press('Enter');
  await page.getByText('$380.00',{exact:true}).first().waitFor();   // 130 + 250
  await foto('2-cuenta-con-paquetes');

  // 3. Cobro dividido: $200 con tarjeta y el resto en efectivo.
  await page.getByTestId('cobrar').click();await page.getByTestId('metodo-TARJETA').click();
  await page.getByLabel('Monto con esta forma de pago, para dividir el cobro').fill('200');
  await page.getByTestId('pagar-parte').click();
  await page.getByText('Falta',{exact:true}).waitFor();
  await foto('3-cobro-dividido');
  await page.getByTestId('confirmar-cobro').click();await page.getByText(/Venta.*guardada/).waitFor();await page.getByTestId('confirmar-cobro').waitFor({state:'hidden'});

  // 4. Ventas del turno: devolver una caja de 6 (marta es encargada).
  await page.getByRole('button',{name:'Ventas del turno'}).click();
  await page.getByText(/^#F1-/).first().waitFor();
  await foto('4-ventas-del-turno');
  await page.getByRole('button',{name:/^Devolver\./}).click();
  await page.getByRole('button',{name:'Una más de Dona glaseada · Caja 6'}).click();
  await page.getByLabel('Razón de la devolución').fill('Caja golpeada');
  await page.getByRole('button',{name:/Devolver \$/}).click();
  await page.getByText(/Devolución de .* registrada/).waitFor();
  await foto('5-devolucion');

  // 5. Conteo: la dona se cuenta en 20 contra lo que diga la tablet.
  await page.getByRole('tab',{name:'Inventario'}).click();
  await page.getByRole('button',{name:'Contar con escáner'}).click();
  const contar=page.getByLabel('Buscar producto para contar');
  for(let i=0;i<3;i++){await contar.fill('7500000000011');await contar.press('Enter');}
  await page.getByText(/Sistema \d+ · -\d+/).waitFor();
  await foto('6-conteo');

  await page.addScriptTag({content:bundle});const st=await page.evaluate(()=>qaRead());
  assert.equal(st.sales.length,1);assert.equal(st.sales[0].total,'380.00');
  assert.deepEqual(st.payments.map(p=>[p.method,p.amount]),[['TARJETA','200.00'],['EFECTIVO','180.00']]);
  assert.equal(st.sales[0].refunded_total,'21.66','una dona de la caja de 6: 130 repartido, 21.66 por pieza');
  // 40 recibidas - 18 vendidas + 1 devuelta
  assert.equal(st.stock.find(x=>x.product_uuid===U.dona).qty,'23');
  assert.ok(st.cash.some(c=>c.type==='SALE_RETURN_CASH'));
  assert.ok(st.events.some(e=>e.event_type==='SALE_REFUNDED'));
  // Chromium sin pantalla niega el Wake Lock que pide expo-keep-awake: no es un error de la app.
  assert.deepEqual(errors.filter(e=>!/Wake Lock/.test(e)),[]);
  console.log('POS_COMPLETO_OK: búsqueda sin acentos, paquetes 6 y 12 en orden, código por lector, cobro 200+180, devolución con inventario y cajón, conteo por código.');
 }catch(e){if(page){console.error((await page.locator('body').innerText()).slice(-1500));await foto('error');}throw e;}finally{await context?.close();await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});
