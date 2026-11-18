import http from 'node:http';
import {readFile,stat,mkdir,writeFile,readdir,unlink} from 'node:fs/promises';
import {resolve,extname,sep,dirname} from 'node:path';
import worker from './worker/index.js';
const root=resolve('dist/client'),bucketRoot=resolve('.sites-runtime/local-bucket');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.wasm':'application/wasm','.pdf':'application/pdf','.json':'application/json'};
function pathFor(key){const path=resolve(bucketRoot,key);if(!path.startsWith(bucketRoot+sep))throw new Error('Invalid bucket key');return path;}
const BUCKET={
 async put(key,value){const path=pathFor(key);await mkdir(dirname(path),{recursive:true});await writeFile(path,typeof value==='string'?value:new Uint8Array(value));},
 async get(key){try{const bytes=await readFile(pathFor(key));return {body:bytes,json:async()=>JSON.parse(bytes.toString()),arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};}catch(e){if(e.code==='ENOENT')return null;throw e;}},
 async delete(keys){for(const key of Array.isArray(keys)?keys:[keys])await unlink(pathFor(key)).catch(e=>{if(e.code!=='ENOENT')throw e;});},
 async list({prefix,limit=1000}){const path=pathFor(prefix);const entries=await readdir(path,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;});return {objects:entries.filter(e=>e.isFile()).slice(0,limit).map(e=>({key:prefix+e.name}))};}
};
const ASSETS={async fetch(request){try{const path=resolve(root,'.'+decodeURIComponent(new URL(request.url).pathname));if(path!==root&&!path.startsWith(root+sep))return new Response('Forbidden',{status:403});const file=(await stat(path)).isDirectory()?resolve(path,'index.html'):path;return new Response(await readFile(file),{headers:{'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':'no-cache'}});}catch{return new Response('Not found',{status:404});}}};
const server=http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://'+req.headers.host);
 // Loopback-only mock sign-in; this server is never included in the Worker bundle.
 if(url.pathname==='/signin-with-chatgpt'){const to=url.searchParams.get('return_to');res.writeHead(302,{'Set-Cookie':'folio_local_auth=1; HttpOnly; SameSite=Lax; Path=/','Location':to?.startsWith('/')&&!to.startsWith('//')?to:'/'});res.end();return;}
 const headers=new Headers(req.headers);for(const name of [...headers.keys()])if(name.startsWith('oai-authenticated-user-'))headers.delete(name);
 if(/(?:^|;\s*)folio_local_auth=1(?:;|$)/.test(req.headers.cookie||''))headers.set('oai-authenticated-user-id','folio-local-owner');
 const options={method:req.method,headers};if(!['GET','HEAD'].includes(req.method)){options.body=req;options.duplex='half';}
 const response=await worker.fetch(new Request(url,options),{BUCKET,ASSETS});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch(e){console.error(e);res.writeHead(500).end('Local server error');}});
server.listen(4173,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:4173 (cloud API uses a separate local test bucket)'));
