import {validateNotes,MAX_PDF} from './validation.js';
import {contentId} from '../src/identity.js';
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
const key=id=>`shares/${id}/metadata.json`;
const validId=id=>/^[a-f0-9]{48}$/.test(id);
const owner=request=>request.headers.get('oai-authenticated-user-id');
async function boundedBody(request,max){
 if(Number(request.headers.get('content-length'))>max)throw Object.assign(new Error('上传数据超过大小限制'),{status:413});
 const reader=request.body?.getReader();if(!reader)return new Uint8Array();
 const parts=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();throw Object.assign(new Error('上传数据超过大小限制'),{status:413});}parts.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}return bytes;
}
async function metadata(env,id){const obj=await env.BUCKET.get(key(id));return obj?{...await obj.json(),_etag:obj.etag}:null;}
function sameOrigin(request){return request.headers.get('Origin')===new URL(request.url).origin&&request.headers.get('Sec-Fetch-Site')!=='cross-site';}
function publicMetadata(doc){return {id:doc.id,name:doc.name,contentId:doc.contentId,size:doc.size,created:doc.created,updated:doc.updated,revision:doc.revision,notes:doc.notes};}
export default {async fetch(request,env){
 const url=new URL(request.url),path=url.pathname;
 try{
  if(path==='/api/session'&&request.method==='GET')return json({signedIn:!!owner(request),cloudReady:!!env.BUCKET});
  if(!path.startsWith('/api/'))return env.ASSETS.fetch(request);
  if(!env.BUCKET)return json({error:'云端存储尚未配置'},503);
  if(path==='/api/shares'&&request.method==='POST'){
   if(!owner(request))return json({error:'请先登录，再发布文档分享'},401);
   if(!sameOrigin(request))return json({error:'请从阅读器页面发起操作'},403);
   const len=Number(request.headers.get('content-length'));if(len>MAX_PDF+3*1024*1024)return json({error:'分享文件最大支持 25 MB，笔记最大 2 MB'},413);
   if(!request.headers.get('content-type')?.startsWith('multipart/form-data'))return json({error:'上传格式无效'},415);
   const payload=await boundedBody(request,MAX_PDF+3*1024*1024);
   const form=await new Response(payload,{headers:{'Content-Type':request.headers.get('content-type')}}).formData(),file=form.get('pdf'),rawNotes=form.get('notes');
   if(!file||typeof file==='string'||file.size>MAX_PDF||file.size<8)return json({error:'请选择 25 MB 以内的 PDF'},400);
   if(typeof rawNotes!=='string'||rawNotes.length>2*1024*1024)return json({error:'笔记数据超过 2 MB'},413);
   const notes=validateNotes(JSON.parse(rawNotes));
   const bytes=await file.arrayBuffer();const header=new TextDecoder().decode(bytes.slice(0,1024));if(!header.includes('%PDF-'))return json({error:'文件不是有效的 PDF'},400);
   const hash=await contentId(bytes),ownerHash=await contentId(new TextEncoder().encode(owner(request)));
   // A bounded owner index prevents accidental unlimited storage on a public tool.
   const existing=await env.BUCKET.list({prefix:`owners/${ownerHash}/`,limit:101});if(existing.objects.length>=100)return json({error:'每个账号最多保留 100 份分享，请先撤销不再需要的分享'},429);
   const id=Array.from(crypto.getRandomValues(new Uint8Array(24)),v=>v.toString(16).padStart(2,'0')).join('');
   const name=String(file.name||'文档.pdf').replace(/[\u0000-\u001f\u007f/\\]/g,'_').slice(0,200);
   const doc={id,name,ownerId:owner(request),ownerHash,contentId:hash,size:file.size,created:Date.now(),updated:Date.now(),revision:1,notes};
   await env.BUCKET.put(`shares/${id}/document.pdf`,bytes,{httpMetadata:{contentType:'application/pdf'}});
   try{await env.BUCKET.put(`owners/${ownerHash}/${id}`,'');await env.BUCKET.put(key(id),JSON.stringify(doc),{httpMetadata:{contentType:'application/json'}});}catch(e){await env.BUCKET.delete([`shares/${id}/document.pdf`,`owners/${ownerHash}/${id}`]);throw e;}
   return json({...publicMetadata(doc),url:`${url.origin}/?share=${id}`},201);
  }
  const match=path.match(/^\/api\/shares\/([a-f0-9]{48})(\/pdf)?$/);
  if(!match||!validId(match[1]))return json({error:'分享不存在或链接已撤销'},404);
  const id=match[1],doc=await metadata(env,id);if(!doc)return json({error:'分享不存在或链接已撤销'},404);
  if(request.method==='GET'||request.method==='HEAD'){
   if(!match[2])return json({...publicMetadata(doc),isOwner:!!owner(request)&&owner(request)===doc.ownerId});
   const obj=await env.BUCKET.get(`shares/${id}/document.pdf`);if(!obj)return json({error:'文档文件不可用'},404);
   return new Response(request.method==='HEAD'?null:obj.body,{headers:{'Content-Type':'application/pdf','Content-Length':String(doc.size),'Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(doc.name)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
  }
  if(!owner(request))return json({error:'请先登录'},401);
  if(owner(request)!==doc.ownerId)return json({error:'只有发布者可以修改这份分享'},403);
  if(!sameOrigin(request))return json({error:'请从阅读器页面发起操作'},403);
  if(match[2])return json({error:'不支持该操作'},405);
  if(request.method==='PUT'){
   if(Number(request.headers.get('content-length'))>2*1024*1024)return json({error:'笔记数据超过 2 MB'},413);
   const raw=new TextDecoder().decode(await boundedBody(request,2*1024*1024));
   const data=JSON.parse(raw);if(data.revision!==doc.revision)return json({error:'分享已在其他页面更新，请重新打开分享设置后再试'},409);
   const notes=validateNotes(data.notes);if(notes.pageCount!==doc.notes.pageCount)return json({error:'文档页数不一致，请创建新分享'},400);
   const etag=doc._etag;delete doc._etag;
   doc.notes=notes;doc.revision++;doc.updated=Date.now();
   const saved=await env.BUCKET.put(key(id),JSON.stringify(doc),{httpMetadata:{contentType:'application/json'},...(etag?{onlyIf:{etagMatches:etag}}:{})});
   if(etag&&saved===null)return json({error:'分享已被更新或撤销，请重新打开分享设置'},409);
   return json({...publicMetadata(doc),url:`${url.origin}/?share=${id}`});
  }
  if(request.method==='DELETE'){
   // Removing metadata immediately closes the public route, then removes its files.
   await env.BUCKET.delete(key(id));await env.BUCKET.delete([`shares/${id}/document.pdf`,`owners/${doc.ownerHash}/${id}`]);return json({revoked:true});
  }
  return json({error:'不支持该操作'},405);
 }catch(e){if(e.status===413)return json({error:e.message},413);if(e instanceof SyntaxError)return json({error:'提交的数据不是有效 JSON'},400);if(e.message?.match(/无效|过大|减少/))return json({error:e.message},400);console.error('Share API failure',e);return json({error:'云端操作暂时失败，请稍后重试'},500);}
}};
