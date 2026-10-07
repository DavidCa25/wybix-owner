import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync,copyFileSync,mkdirSync} from 'node:fs';
import {resolve,relative} from 'node:path';import {createHash} from 'node:crypto';
const name=process.argv[2];if(!['owner','pos-mobile'].includes(name))throw Error('Choose owner or pos-mobile');
const root=process.cwd(),app=resolve(root,'apps',name),dist=resolve(app,'dist');
const env={...process.env};
for(const line of readFileSync(resolve(root,'.env'),'utf8').split(/\r?\n/)){const i=line.indexOf('=');if(i>0&&line.startsWith('EXPO_PUBLIC_SUPABASE_'))env[line.slice(0,i)]=line.slice(i+1).trim().replace(/^['"]|['"]$/g,'');}
if(name==='pos-mobile'){const dir=resolve(app,'public/sqlite');mkdirSync(dir,{recursive:true});for(const n of ['sql-wasm.js','sql-wasm.wasm'])copyFileSync(resolve(root,'node_modules/sql.js/dist',n),resolve(dir,n));}
execFileSync(process.execPath,[resolve(root,'node_modules/expo/bin/cli'),'export','--platform','web'],{cwd:app,env,stdio:'inherit'});
const index=resolve(dist,'index.html');let html=readFileSync(index,'utf8');
html=html.replace(/maximum-scale=1,?\s*/g,'').replace('</head>','<link rel="manifest" href="/manifest.json"><link rel="apple-touch-icon" href="/icon-192.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="'+(name==='owner'?'Wybix Owner':'Wybix POS')+'"><meta name="theme-color" content="#0F1826"><script src="/pwa.js" defer></script></head>');writeFileSync(index,html);
const files=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(resolve(dir,e.name)):[resolve(dir,e.name)]);
const assets=files(dist).filter(f=>!f.endsWith('.map')&&!f.endsWith('sw.js')&&!f.includes('expo-logs')).map(f=>'/'+relative(dist,f).replaceAll('\\','/'));
const fingerprint=createHash('sha256').update(readFileSync(new URL(import.meta.url)));
for(const asset of assets)fingerprint.update(asset).update(readFileSync(resolve(dist,'.'+asset)));
const version=fingerprint.digest('hex').slice(0,16);
const sw=`const CACHE='wybix-${name}-${version}';const FILES=${JSON.stringify(assets)};
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES))));
self.addEventListener('activate',e=>e.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('wybix-${name}-')&&k!==CACHE).map(k=>caches.delete(k)))),self.clients.claim()])));
self.addEventListener('message',e=>{if(e.data==='ACTIVATE_UPDATE')self.skipWaiting();});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==self.location.origin)return;
if(e.request.mode==='navigate'){e.respondWith(fetch(e.request).catch(async()=>{const r=await (await caches.open(CACHE)).match('/index.html');return r?new Response(r.body,{status:200,headers:r.headers}):Response.error();}));return;}
if(FILES.includes(u.pathname))e.respondWith(caches.open(CACHE).then(c=>c.match(u.pathname)).then(r=>r||fetch(e.request)));});`;
writeFileSync(resolve(dist,'sw.js'),sw);writeFileSync(resolve(dist,'pwa-build.json'),JSON.stringify({app:name,version,builtAt:new Date().toISOString()}));
console.log('PWA_READY '+name+' '+version);
