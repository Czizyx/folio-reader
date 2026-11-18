import test from 'node:test';import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import {validateNotes} from '../worker/validation.js';
const origin='https://folio.example';
const note={id:'note-1',type:'text',point:[10,100],color:'#285747',fontSize:16,text:'公开测试笔记',created:1};
const notes=()=>({format:'folio-share',version:1,pageCount:1,annotations:{1:[structuredClone(note)]},rotation:{},crop:0});
function bucket(){const data=new Map();return {data,async put(k,v){data.set(k,typeof v==='string'?v:new Uint8Array(v));},async get(k){const v=data.get(k);return v===undefined?null:{body:v,json:async()=>JSON.parse(v)};},async delete(keys){for(const k of Array.isArray(keys)?keys:[keys])data.delete(k);},async list({prefix,limit}){return {objects:[...data.keys()].filter(k=>k.startsWith(prefix)).slice(0,limit).map(key=>({key}))};}};}
function req(path,method='GET',body=null,user=null,extra={}){const headers={...extra};if(user)headers['oai-authenticated-user-id']=user;if(body)headers.Origin=origin;return new Request(origin+path,{method,headers,body});}
function form(){const f=new FormData();f.append('pdf',new Blob(['%PDF-1.7\nA test PDF body'],{type:'application/pdf'}),'test.pdf');f.append('notes',JSON.stringify(notes()));return f;}
test('publisher creates a share, anonymous visitors read PDF + notes, only owner updates/revokes',async()=>{
 const BUCKET=bucket(),env={BUCKET};
 assert.equal((await worker.fetch(req('/api/shares','POST',form()),env)).status,401);
 const created=await worker.fetch(req('/api/shares','POST',form(),'owner-1'),env);assert.equal(created.status,201);const doc=await created.json();assert.match(doc.id,/^[a-f0-9]{48}$/);assert.equal(doc.ownerId,undefined);
 const publicDoc=await (await worker.fetch(req('/api/shares/'+doc.id),env)).json();assert.equal(publicDoc.notes.annotations[1][0].text,note.text);assert.equal(publicDoc.isOwner,false);assert.equal(publicDoc.ownerId,undefined);
 const pdf=await worker.fetch(req('/api/shares/'+doc.id+'/pdf'),env);assert.equal(pdf.status,200);assert.match(await pdf.text(),/^%PDF-/);
 const changed=notes();changed.annotations[1][0].text='更新后的笔记';const payload=JSON.stringify({revision:1,notes:changed});
 assert.equal((await worker.fetch(req('/api/shares/'+doc.id,'PUT',payload,'other-user'),env)).status,403);
 const updated=await worker.fetch(req('/api/shares/'+doc.id,'PUT',payload,'owner-1'),env);assert.equal(updated.status,200);assert.equal((await updated.json()).revision,2);
 assert.equal((await worker.fetch(req('/api/shares/'+doc.id,'PUT',payload,'owner-1'),env)).status,409);
 assert.equal((await worker.fetch(req('/api/shares/'+doc.id,'DELETE',null,'other-user',{Origin:origin}),env)).status,403);
 assert.equal((await worker.fetch(req('/api/shares/'+doc.id,'DELETE',null,'owner-1',{Origin:origin}),env)).status,200);
 assert.equal((await worker.fetch(req('/api/shares/'+doc.id),env)).status,404);
 assert.equal((await worker.fetch(req('/api/shares/'+doc.id+'/pdf'),env)).status,404);assert.equal(BUCKET.data.size,0);
});
test('cross-origin writes and malformed or oversized uploads are rejected',async()=>{
 const env={BUCKET:bucket()};const cross=req('/api/shares','POST',form(),'owner');cross.headers.set('Origin','https://evil.example');assert.equal((await worker.fetch(cross,env)).status,403);
 const invalid=form();invalid.set('notes',JSON.stringify({...notes(),annotations:{0:[note]}}));assert.equal((await worker.fetch(req('/api/shares','POST',invalid,'owner'),env)).status,400);
 const fake=form();fake.set('pdf',new Blob(['not a pdf document']),'test.pdf');assert.equal((await worker.fetch(req('/api/shares','POST',fake,'owner'),env)).status,400);
 const huge=req('/api/shares','POST','x','owner',{'Content-Type':'multipart/form-data','Content-Length':String(31*1024*1024)});assert.equal((await worker.fetch(huge,env)).status,413);
});
test('notes reject invalid coordinates, arbitrary SVG colors, and unsupported rotation',()=>{
 const a=notes();a.annotations[1][0].point=[Infinity,1];assert.throws(()=>validateNotes(a));const b=notes();b.annotations[1][0].color='url(https://evil.example)';assert.throws(()=>validateNotes(b));assert.throws(()=>validateNotes({...notes(),rotation:{1:45}}));
});
