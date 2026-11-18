import * as pdfjs from 'pdfjs-dist';
import { PDFDocument, rgb } from 'pdf-lib';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { fillIcons, icon } from './icons.js';
import { storage } from './store.js';
import { GestureGate, getSignals, classify } from './gestures.js';
import { contentId } from './identity.js';
pdfjs.GlobalWorkerOptions.workerSrc=new URL('./pdf.worker.min.mjs',import.meta.url).href;
const asset=name=>new URL('./'+name,import.meta.url).href;
const $=id=>document.getElementById(id);
const state={pdf:null,bytes:null,id:null,name:'',page:1,mode:'page',zoom:1,tool:'select',color:'#285747',width:2.5,annotations:{},rotation:{},crop:0,turnStep:'page',fontSize:20,lineHeight:1.9,theme:'paper',shareId:null,shared:false,sharedMeta:null};
let renderVersion=0,openVersion=0,renderRunning=false,renderAgain=false,saveTimer,toastTimer,thumbObserver,history=[],future=[],filterPage=false,typingAnchor=null,storageFailed=false,loadingTask=null,outline=[];
const NS='http://www.w3.org/2000/svg';
fillIcons();
const escapeHTML=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(message,error=false){$('toast').textContent=message;$('toast').classList.toggle('error',error);$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,error?6500:3600);}
function busy(on,label='正在打开 PDF…'){$('loading').hidden=!on;$('loading-label').textContent=label;}
function dialog(id){$(id).showModal();}
function closeDialog(id){$(id).close();}
function fail(err,context){console.error(context,err);toast(context+'：'+(err?.message||'请重试'),true);}
function safeAction(fn,context){return (...args)=>Promise.resolve().then(()=>fn(...args)).catch(e=>fail(e,context));}
function prefs(){try{return JSON.parse(localStorage.getItem('folio-prefs')||'{}');}catch{return {};}}
function savePrefs(){try{localStorage.setItem('folio-prefs',JSON.stringify({theme:state.theme,fontSize:state.fontSize,lineHeight:state.lineHeight,turnStep:state.turnStep}));}catch{}}
function stateRecord(){return {id:state.id,page:state.page,mode:state.mode,annotations:structuredClone(state.annotations),rotation:{...state.rotation},crop:state.crop,shareId:state.shareId,updated:Date.now()};}
async function persist(record=state.id&&stateRecord()){
 if(!record||state.shared)return;
 try{await storage.putState(record);if(record.id===state.id){$('save-status').textContent='已自动保存 · 仅在此浏览器';storageFailed=false;}}
 catch(e){storageFailed=true;$('save-status').textContent='本机保存失败，请导出笔记备份';toast('浏览器存储不可用或空间不足，请立即导出笔记备份。',true);}
}
function scheduleSave(){clearTimeout(saveTimer);if(!state.id||state.shared)return;$('save-status').textContent='正在保存笔记…';const record=stateRecord();saveTimer=setTimeout(()=>persist(record),300);}
function checkpoint(){history.push(structuredClone(state.annotations));if(history.length>45)history.shift();future=[];updateUndo();}
function updateUndo(){$('undo').disabled=!history.length;$('redo').disabled=!future.length;}
function undo(){if(state.shared||!history.length)return;future.push(structuredClone(state.annotations));state.annotations=history.pop();afterChange();}
function redo(){if(state.shared||!future.length)return;history.push(structuredClone(state.annotations));state.annotations=future.pop();afterChange();}
function afterChange(){updateUndo();drawAllAnnotations();renderNotes();updateThumbBadges();scheduleSave();}
function setTool(tool){
 if(state.shared&&tool!=='select'){toast('分享文档为只读，发布者的笔记不会被改动。');return;}
 if(state.mode==='reflow'&&tool!=='select'){toast('自由批注请切换到原版页面。');return;}
 state.tool=tool;document.querySelectorAll('[data-tool]').forEach(el=>el.classList.toggle('active',el.dataset.tool===tool));
 document.querySelectorAll('.page-annotations').forEach(el=>{el.classList.toggle('reading',tool==='select');el.dataset.tool=tool;});
 $('reader-hint').textContent={select:'阅读模式 · 方向键翻页',pen:'自由手写 · 面部翻页已暂停',highlight:'荧光标记 · 拖动即可圈画',text:'点击页面，写下一句想法',eraser:'点击或划过笔迹，擦除整条批注'}[tool];
 gestureGate.reset();updateCameraStatus();
}
async function openBytes(bytes,name,{demo=false,shared=null}={}){
 if(cloudBusy){toast('正在上传分享，请稍候再切换文档。');return;}
 const generation=++openVersion;
 if(state.id){clearTimeout(saveTimer);await persist();}
 busy(true);setTool('select');
 let task;
 try{
  const original=new Uint8Array(bytes);if(original.length>150*1024*1024)throw new Error('首版支持 150 MB 以内的 PDF');
  // Supply a copy: the PDF worker transfers ownership of its input buffer.
  task=pdfjs.getDocument({data:original.slice(),cMapUrl:asset('cmaps/'),cMapPacked:true,standardFontDataUrl:asset('standard_fonts/'),wasmUrl:asset('pdf-wasm/'),isEvalSupported:false});loadingTask=task;
  task.onPassword=(callback,reason)=>{
   $('password-message').textContent=reason===pdfjs.PasswordResponses.INCORRECT_PASSWORD?'密码不正确，请重试。':'请输入打开文档的密码。';
   $('pdf-password').value='';if(!$('password-dialog').open)dialog('password-dialog');
   $('password-form').onsubmit=e=>{e.preventDefault();const password=$('pdf-password').value;closeDialog('password-dialog');callback(password);};
   $('password-cancel').onclick=()=>{closeDialog('password-dialog');task.destroy();busy(false);};
  };
  const pdf=await task.promise;if(generation!==openVersion){pdf.destroy();return;}
  // PDF producers can retain an embedded fingerprint after modifying a file.
  // Hash the bytes so an exported, flattened PDF never inherits editable marks.
  const id=await contentId(original);
  if(shared&&id!==shared.contentId)throw new Error('云端文件校验失败，请重新打开分享链接');
  let saved;if(!shared)try{saved=await storage.getState(id);}catch{}
  const old=state.pdf;
  Object.assign(state,{pdf,bytes:original,id,name,page:Math.min(pdf.numPages,Math.max(1,saved?.page||1)),mode:['page','spread','flow','reflow'].includes(saved?.mode)?saved.mode:'page',zoom:1,annotations:shared?.notes.annotations||saved?.annotations||{},rotation:shared?.notes.rotation||saved?.rotation||{},crop:shared?.notes.crop??saved?.crop??0,shareId:shared?.id||saved?.shareId||null,shared:!!shared,sharedMeta:shared});
  document.body.classList.toggle('share-view',state.shared);$('share-banner').hidden=!state.shared;
  $('notes-panel').querySelector('h2').textContent=state.shared?'发布者的笔记':'留一点想法';
  $('notes-panel').querySelector('.eyebrow').textContent=state.shared?'SHARED NOTES':'MAKE IT YOURS';
  if(shared)$('share-updated').textContent=`只读 · 更新于 ${new Date(shared.updated).toLocaleString('zh-CN')} · 共 ${Object.values(shared.notes.annotations).flat().length} 条笔记`;
  else if(new URL(location.href).searchParams.has('share'))window.history.replaceState(null,'',location.pathname);
  history=[];future=[];updateUndo();$('doc-title').textContent=name;$('document-meta').textContent=`${pdf.numPages} 页 · ${original.length>1048576?(original.length/1048576).toFixed(1)+' MB':Math.round(original.length/1024)+' KB'}${demo?' · 示例文档':''}`;
  $('empty-state').hidden=true;$('page-number').max=pdf.numPages;$('page-total').textContent='/ '+pdf.numPages;$('crop').value=state.crop;updateMode();
  if(shared){$('save-status').textContent='云端分享 · PDF 与发布者笔记只读';}
  else try{await storage.putDoc({id,name,bytes:original,updated:Date.now(),demo});localStorage.setItem('folio-last',id);$('save-status').textContent='已自动保存 · 仅在此浏览器';}catch{storageFailed=true;$('save-status').textContent='当前为临时阅读，请导出笔记备份';toast('本机文件保存失败，当前仍可阅读与批注。请及时导出备份。',true);}
  await render();buildThumbnails();renderNotes();renderLibrary();
  outline=await pdf.getOutline()||[];renderOutline();
  if(old&&old!==pdf)await old.destroy();
  scheduleSave();
 }catch(e){if(generation===openVersion){fail(e,'无法打开 PDF');if(!state.pdf)$('empty-state').hidden=false;}}
 finally{if(generation===openVersion){busy(false);loadingTask=null;}}
}
async function loadDemo(){const r=await fetch('./demo.pdf');if(!r.ok)throw new Error('示例文档加载失败');await openBytes(await r.arrayBuffer(),'A quiet afternoon · 示例.pdf',{demo:true});}
async function openFile(file){if(!file)return;if(!/\.pdf$/i.test(file.name)&&file.type!=='application/pdf'){toast('请选择 PDF 文件。',true);return;}await openBytes(await file.arrayBuffer(),file.name);}
function updateMode(){document.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('active',b.dataset.mode===state.mode));$('zoom-reset').textContent=state.zoom===1?'适合页面':Math.round(state.zoom*100)+'%';$('page-number').value=state.page;$('prev-page').disabled=!state.pdf||state.page<=1;$('next-page').disabled=!state.pdf||state.page>=state.pdf.numPages;}
async function setMode(mode){if(!state.pdf)return;state.mode=mode;state.zoom=1;if(mode==='reflow')setTool('select');updateMode();scheduleSave();await render();}
async function render(){
 renderVersion++;renderAgain=true;
 if(renderRunning)return;
 renderRunning=true;
 try{while(renderAgain){renderAgain=false;const v=renderVersion;try{await performRender(v);}catch(e){if(v===renderVersion)fail(e,'页面渲染失败');}}}
 finally{renderRunning=false;}
}
async function performRender(version){
 if(!state.pdf)return;const pdf=state.pdf,pageNumber=state.page,mode=state.mode;
 const root=$('pages');root.replaceChildren();root.className='pages'+(mode==='flow'?' flow':'');
 $('workspace').scrollTop=0;$('workspace').scrollLeft=0;
 if(mode==='reflow'){await renderReflow(root,pdf,pageNumber,version);return;}
 const count=mode==='spread'?2:mode==='flow'?Math.min(8,pdf.numPages-pageNumber+1):1;
 const availableWidth=Math.max(240,$('workspace').clientWidth-(innerWidth<640?20:56));
 const availableHeight=Math.max(320,$('workspace').clientHeight-78);
 const numbers=Array.from({length:count},(_,i)=>pageNumber+i).filter(n=>n<=pdf.numPages);
 for(const number of numbers){
  if(version!==renderVersion)return;
  const page=await pdf.getPage(number);if(version!==renderVersion)return;
  const rotation=(page.rotate+(state.rotation[number]||0))%360;
  const unit=page.getViewport({scale:1,rotation});const crop=state.crop/100,visible=1-crop*2;
  const fitWidth=(availableWidth-(mode==='spread'?22:0))/(mode==='spread'?numbers.length:1);
  const scale=(mode==='flow'?fitWidth/(unit.width*visible):Math.min(fitWidth/(unit.width*visible),availableHeight/(unit.height*visible)))*state.zoom;
  const viewport=page.getViewport({scale,rotation});
  const frame=document.createElement('section');frame.className='paper-frame';frame.dataset.page=number;frame.setAttribute('aria-label',`第 ${number} 页`);
  frame.style.width=`${viewport.width*visible}px`;frame.style.height=`${viewport.height*visible}px`;
  const inner=document.createElement('div');inner.className='page-inner';inner.style.width=`${viewport.width}px`;inner.style.height=`${viewport.height}px`;inner.style.left=`${-viewport.width*crop}px`;inner.style.top=`${-viewport.height*crop}px`;
  const canvas=document.createElement('canvas');canvas.className='pdf-canvas';const ratio=Math.min(devicePixelRatio||1,2,Math.sqrt(16000000/(viewport.width*viewport.height)));
  canvas.width=Math.ceil(viewport.width*ratio);canvas.height=Math.ceil(viewport.height*ratio);canvas.style.width=`${viewport.width}px`;canvas.style.height=`${viewport.height}px`;
  inner.append(canvas);frame.append(inner);root.append(frame);
  await page.render({canvasContext:canvas.getContext('2d'),viewport,transform:ratio===1?null:[ratio,0,0,ratio,0,0]}).promise;
  if(version!==renderVersion)return;
  const tint=document.createElement('div');tint.className='paper-tint';inner.append(tint);
  const textContainer=document.createElement('div');textContainer.className='textLayer';inner.append(textContainer);
  textContainer.style.setProperty('--scale-factor',viewport.scale);textContainer.style.setProperty('--total-scale-factor',viewport.scale);
  try{await new pdfjs.TextLayer({textContentSource:page.streamTextContent(),container:textContainer,viewport}).render();}catch(e){console.warn('Text layer unavailable',e);}
  const svg=document.createElementNS(NS,'svg');svg.classList.add('page-annotations');svg.setAttribute('viewBox',`0 0 ${viewport.width} ${viewport.height}`);svg.dataset.page=number;svg._viewport=viewport;
  inner.append(svg);attachAnnotationEvents(svg,number,viewport);drawAnnotations(svg,number,viewport);
  svg.classList.toggle('reading',state.tool==='select');svg.dataset.tool=state.tool;
  const tag=document.createElement('span');tag.className='page-tag';tag.textContent=String(number).padStart(2,'0');frame.append(tag);
 }
 if(mode==='flow'&&pageNumber+count<=pdf.numPages){const more=document.createElement('button');more.className='secondary';more.textContent='继续阅读后面的页面';more.onclick=()=>goPage(pageNumber+count);root.append(more);}
 updateMode();markThumb();
}
async function renderReflow(root,pdf,number,version){
 const page=await pdf.getPage(number);const text=await page.getTextContent();if(version!==renderVersion)return;
 const article=document.createElement('article');article.className='reflow-article';article.style.setProperty('--reading-size',state.fontSize+'px');article.style.setProperty('--reading-leading',state.lineHeight);
 const label=document.createElement('div');label.className='reflow-label';label.textContent=`COMFORT READING  /  第 ${number} 页`;article.append(label);
 const parts=[];let line='',lastY=null;for(const item of text.items){if(!('str'in item))continue;const y=item.transform[5];if(lastY!==null&&Math.abs(y-lastY)>Math.max(8,item.height*.7)&&line){parts.push(line);line='';}line+=item.str+(item.hasEOL?'\n':' ');lastY=y;if(item.hasEOL&&line){parts.push(line);line='';}}
 if(line)parts.push(line);
 if(!parts.join('').trim()){const p=document.createElement('p');p.className='reflow-warning';p.textContent='这一页没有可提取的文字，可能是扫描件。请切回原版阅读；首版暂不提供 OCR。';article.append(p);}
 else{
  const warning=document.createElement('p');warning.className='reflow-warning';warning.textContent='此视图按页提取文字。乐谱、公式、图片和多栏阅读顺序可能不完整，请对照原版；自由手写笔记在原版中查看。';article.append(warning);
  for(const part of parts){const p=document.createElement('p');p.textContent=part.trim();article.append(p);}
 }
 const source=document.createElement('button');source.className='reflow-source';source.textContent=`查看第 ${number} 页原版与批注`;source.onclick=()=>setMode('page');article.append(source);root.append(article);updateMode();markThumb();
}
async function goPage(number){if(!state.pdf)return;const n=Math.min(state.pdf.numPages,Math.max(1,Math.trunc(Number(number))||1));if(n===state.page){updateMode();return;}state.page=n;updateMode();if(filterPage)renderNotes();scheduleSave();await render();}
function turn(direction){
 if(!state.pdf||document.querySelector('dialog[open]'))return;
 const w=$('workspace');
 if(state.turnStep==='half'&&state.mode!=='reflow'){
  const frames=$('pages').querySelectorAll('.paper-frame');
  if(frames.length&&w.scrollHeight>w.clientHeight+20){
   if(direction>0&&w.scrollTop+w.clientHeight<w.scrollHeight-12){w.scrollBy({top:w.clientHeight*.52,behavior:'smooth'});return;}
   if(direction<0&&w.scrollTop>12){w.scrollBy({top:-w.clientHeight*.52,behavior:'smooth'});return;}
  }
 }
 goPage(state.page+direction*(state.mode==='spread'?2:1));
}
function markThumb(){document.querySelectorAll('.thumb-button').forEach(b=>b.classList.toggle('active',Number(b.dataset.page)===state.page));}
async function buildThumbnails(){
 thumbObserver?.disconnect();$('page-list').replaceChildren();const pdf=state.pdf;
 thumbObserver=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting){thumbObserver.unobserve(entry.target);renderThumb(entry.target,pdf);}}},{root:$('page-list'),rootMargin:'250px'});
 for(let n=1;n<=pdf.numPages;n++){
  const b=document.createElement('button');b.className='thumb-button';b.dataset.page=n;b.innerHTML=`<span class="thumb-wrap"><canvas></canvas><span class="thumb-badge" hidden></span></span><span>${String(n).padStart(2,'0')}</span>`;b.title='跳到第 '+n+' 页';b.onclick=()=>{goPage(n);if(innerWidth<640)toggleSidebar(false);};$('page-list').append(b);thumbObserver.observe(b);
 }
 markThumb();updateThumbBadges();
}
async function renderThumb(button,pdf){try{const page=await pdf.getPage(Number(button.dataset.page));if(pdf!==state.pdf)return;const viewport=page.getViewport({scale:.24});const canvas=button.querySelector('canvas');canvas.width=viewport.width;canvas.height=viewport.height;await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;}catch{}}
function updateThumbBadges(){document.querySelectorAll('.thumb-button').forEach(b=>{const count=(state.annotations[b.dataset.page]||[]).length;const badge=b.querySelector('.thumb-badge');badge.hidden=!count;badge.textContent=count;});}
async function renderLibrary(){try{const docs=(await storage.list()).sort((a,b)=>b.updated-a.updated);$('library-list').replaceChildren();for(const d of docs){const b=document.createElement('button');b.className='library-item';b.innerHTML=`<b>${escapeHTML(d.name)}</b><small>${new Date(d.updated).toLocaleDateString('zh-CN')} · ${Math.round(d.bytes.length/1024)} KB</small>`;b.onclick=()=>openBytes(d.bytes,d.name,{demo:d.demo,knownId:d.id});$('library-list').append(b);}if(!docs.length)$('library-list').innerHTML='<p class="side-empty">打开的文件会出现在这里。</p>';}catch{$('library-list').innerHTML='<p class="side-empty">此浏览器的本机存储不可用。</p>';}}
function renderOutline(){
 $('outline-list').replaceChildren();if(!outline.length){$('outline-list').innerHTML='<p class="side-empty">此文档没有内嵌目录。<br>可通过页面缩略图导航。</p>';return;}
 const add=(items,depth=0)=>{for(const item of items){const b=document.createElement('button');b.className='outline-item';b.style.paddingLeft=(7+depth*10)+'px';b.textContent=item.title;b.onclick=safeAction(async()=>{const dest=typeof item.dest==='string'?await state.pdf.getDestination(item.dest):item.dest;if(!dest)return;const n=typeof dest[0]==='number'?dest[0]:await state.pdf.getPageIndex(dest[0]);goPage(n+1);},'目录跳转失败');$('outline-list').append(b);if(item.items?.length)add(item.items,depth+1);}};add(outline);
}
function svgEl(name,attrs={}){const el=document.createElementNS(NS,name);for(const [k,v]of Object.entries(attrs))el.setAttribute(k,v);return el;}
function pathData(points,viewport){return points.map((pt,i)=>{const [x,y]=viewport.convertToViewportPoint(...pt);return `${i?'L':'M'}${x.toFixed(2)},${y.toFixed(2)}`;}).join(' ');}
function drawAnnotation(svg,ann,viewport){
 let el;
 if(ann.type==='text'){
  const [x,y]=viewport.convertToViewportPoint(...ann.point);
  el=svgEl('text',{x,y,fill:ann.color,'font-size':ann.fontSize*viewport.scale,'font-family':'"Microsoft YaHei", "Segoe UI", sans-serif','dominant-baseline':'hanging',transform:`rotate(${viewport.rotation} ${x} ${y})`});
  ann.text.split('\n').forEach((line,i)=>{const t=svgEl('tspan',{x,dy:i?ann.fontSize*viewport.scale*1.4:0});t.textContent=line||' ';el.append(t);});
 }else el=svgEl('path',{d:pathData(ann.points,viewport),fill:'none',stroke:ann.color,'stroke-width':ann.width*viewport.scale,'stroke-linecap':'round','stroke-linejoin':'round',opacity:ann.type==='highlight'?.32:1});
 el.dataset.annotation=ann.id;el.classList.add('annotation-hit');svg.append(el);return el;
}
function drawAnnotations(svg,number,viewport){svg.replaceChildren();for(const ann of state.annotations[number]||[])drawAnnotation(svg,ann,viewport);}
function drawAllAnnotations(){document.querySelectorAll('.page-annotations').forEach(svg=>drawAnnotations(svg,Number(svg.dataset.page),svg._viewport));}
function pdfPoint(event,svg,viewport){const rect=svg.getBoundingClientRect();return viewport.convertToPdfPoint((event.clientX-rect.left)*viewport.width/rect.width,(event.clientY-rect.top)*viewport.height/rect.height);}
function eraseAt(event,svg,number){const target=document.elementFromPoint(event.clientX,event.clientY);const id=target?.closest('[data-annotation]')?.dataset.annotation;if(id){const list=state.annotations[number]||[];const index=list.findIndex(a=>a.id===id);if(index>=0){list.splice(index,1);drawAnnotations(svg,number,svg._viewport);}}}
function attachAnnotationEvents(svg,number,viewport){
 let drawing=null,node=null,erasing=false,changed=false;
 svg.addEventListener('pointerdown',e=>{
  if(state.tool==='select'||e.button!==0)return;e.preventDefault();svg.setPointerCapture(e.pointerId);
  if(state.tool==='text'){typingAnchor={page:number,point:pdfPoint(e,svg,viewport)};$('note-text').value='';dialog('text-dialog');setTimeout(()=>$('note-text').focus(),30);return;}
  if(state.tool==='eraser'){checkpoint();erasing=true;changed=false;const count=(state.annotations[number]||[]).length;eraseAt(e,svg,number);changed=(state.annotations[number]||[]).length!==count;return;}
  checkpoint();drawing={id:crypto.randomUUID(),type:state.tool,color:state.color,width:state.tool==='highlight'?state.width*7:state.width,points:[pdfPoint(e,svg,viewport)],created:Date.now()};
  node=drawAnnotation(svg,drawing,viewport);
 });
 svg.addEventListener('pointermove',e=>{
  if(erasing){const count=(state.annotations[number]||[]).length;eraseAt(e,svg,number);changed||=(state.annotations[number]||[]).length!==count;return;}
  if(!drawing)return;const events=e.getCoalescedEvents?.()||[e];for(const event of events){const pt=pdfPoint(event,svg,viewport);const last=drawing.points.at(-1);if(Math.hypot(pt[0]-last[0],pt[1]-last[1])>.4)drawing.points.push(pt);}node.setAttribute('d',pathData(drawing.points,viewport));
 });
 const finish=e=>{
  if(erasing){erasing=false;if(changed)afterChange();else{history.pop();updateUndo();}return;}
  if(!drawing)return;
  if(drawing.points.length===1)drawing.points.push([drawing.points[0][0]+.1,drawing.points[0][1]+.1]);
  (state.annotations[number]??=[]).push(drawing);drawing=null;node=null;afterChange();
 };
 svg.addEventListener('pointerup',finish);svg.addEventListener('pointercancel',finish);svg.addEventListener('lostpointercapture',finish);
}
function deleteAnnotation(page,id){if(state.shared)return;checkpoint();state.annotations[page]=(state.annotations[page]||[]).filter(a=>a.id!==id);afterChange();}
function renderNotes(){
 const all=Object.entries(state.annotations).flatMap(([page,list])=>list.map(a=>({...a,page:Number(page)}))).sort((a,b)=>a.page-b.page||a.created-b.created);
 $('note-count').textContent=all.length;$('note-list').replaceChildren();const shown=all.filter(a=>!filterPage||a.page===state.page);
 if(!shown.length){$('note-list').innerHTML=`<div class="empty-notes">${icon('pen')}<span>${filterPage?'这一页还没有笔记':'这里，等着你的第一笔。'}<br>选择上方工具，在纸上自由记录。</span></div>`;return;}
 for(const a of shown){const card=document.createElement('div');card.className='note-item';card.tabIndex=0;card.setAttribute('role','button');card.setAttribute('aria-label',`查看第 ${a.page} 页笔记`);card.innerHTML=`<div class="note-item-top"><span><span class="note-item-color" style="background:${escapeHTML(a.color)}"></span>第 ${a.page} 页 · ${{pen:'手写',highlight:'标记',text:'文字'}[a.type]}</span><span>${new Date(a.created).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</span></div><p>${a.type==='text'?escapeHTML(a.text):a.type==='highlight'?'一处值得停留的标记':'一笔留在纸上的想法'}</p><button class="icon-button delete-note" aria-label="删除笔记">${icon('trash')}</button>`;card.onclick=()=>{if(state.mode==='reflow')state.mode='page';goPage(a.page);if(a.page===state.page){updateMode();render();}if(innerWidth<900)toggleNotes(false);};card.onkeydown=e=>{if(e.key==='Enter')card.click();};card.querySelector('.delete-note').onclick=e=>{e.stopPropagation();deleteAnnotation(a.page,a.id);};$('note-list').append(card);}
}
function download(bytes,name,type){const url=URL.createObjectURL(new Blob([bytes],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
function backup(){if(!state.pdf){toast('请先打开 PDF。');return;}download(JSON.stringify({format:'folio-notes',version:1,fingerprint:state.id,name:state.name,annotations:state.annotations,rotation:state.rotation,exported:new Date().toISOString()},null,2),state.name.replace(/\.pdf$/i,'')+'.folio-notes.json','application/json');closeDialog('export-dialog');toast('笔记备份已导出。');}
function validateBackup(data){
 if(data.format!=='folio-notes'||data.version!==1||data.fingerprint!==state.id)throw new Error('备份格式不正确，或不属于当前 PDF');
 if(!data.annotations||typeof data.annotations!=='object'||Array.isArray(data.annotations))throw new Error('备份缺少批注数据');
 let total=0;
 for(const [page,list]of Object.entries(data.annotations)){
  if(!/^\d+$/.test(page)||Number(page)<1||Number(page)>state.pdf.numPages||!Array.isArray(list))throw new Error('批注页码无效');
  for(const a of list){
   total++;if(total>20000)throw new Error('笔记数量过多');
   if(!['text','pen','highlight'].includes(a.type)||typeof a.id!=='string'||!/^#[0-9a-f]{6}$/i.test(a.color)||!Number.isFinite(a.created))throw new Error('批注数据无效');
   const validPoint=p=>Array.isArray(p)&&p.length===2&&p.every(n=>Number.isFinite(n)&&Math.abs(n)<100000);
   if(a.type==='text'){if(typeof a.text!=='string'||a.text.length>2000||!validPoint(a.point)||!Number.isFinite(a.fontSize)||a.fontSize<1||a.fontSize>100)throw new Error('文字笔记无效');}
   else if(!Array.isArray(a.points)||a.points.length>100000||!a.points.every(validPoint)||!Number.isFinite(a.width)||a.width<=0||a.width>200)throw new Error('笔迹数据无效');
  }
 }
 return data.annotations;
}
async function importBackup(file){if(state.shared)throw new Error('分享文档为只读，请先打开自己的 PDF');if(!state.pdf)throw new Error('请先打开对应的 PDF');if(file.size>25*1024*1024)throw new Error('备份文件过大');const data=JSON.parse(await file.text());const annotations=validateBackup(data);if(!confirm('导入将替换当前文档的笔记。你可以用“撤销”恢复。是否继续？'))return;checkpoint();state.annotations=annotations;afterChange();closeDialog('export-dialog');toast('笔记已恢复，可以继续编辑。');}
function hexColor(hex){return rgb(...[1,3,5].map(n=>parseInt(hex.slice(n,n+2),16)/255));}
async function exportPdf(){
 if(!state.pdf)return;closeDialog('export-dialog');busy(true,'正在合成批注 PDF…');
 try{
  const pdf=await PDFDocument.load(state.bytes.slice());const pages=pdf.getPages();
  for(const [number,list]of Object.entries(state.annotations)){
   const page=pages[Number(number)-1];
   for(const a of list){
    if(a.type==='text'){
     // Browser-rendered transparent image preserves Chinese without remote font downloads.
     const lines=a.text.split('\n');const c=document.createElement('canvas');const ctx=c.getContext('2d');const scale=3;ctx.font=`${a.fontSize*scale}px "Microsoft YaHei", "Segoe UI", sans-serif`;
     c.width=Math.min(12000,Math.ceil(Math.max(...lines.map(l=>ctx.measureText(l).width),1)+8));c.height=Math.min(12000,Math.ceil(lines.length*a.fontSize*1.4*scale+8));
     ctx.font=`${a.fontSize*scale}px "Microsoft YaHei", "Segoe UI", sans-serif`;ctx.textBaseline='top';ctx.fillStyle=a.color;lines.forEach((l,i)=>ctx.fillText(l,2,i*a.fontSize*1.4*scale+2));
     const img=await pdf.embedPng(c.toDataURL());page.drawImage(img,{x:a.point[0],y:a.point[1]-c.height/scale,width:c.width/scale,height:c.height/scale});
    }else{
     const color=hexColor(a.color),opacity=a.type==='highlight'?.32:1;
     for(let i=1;i<a.points.length;i++){page.drawLine({start:{x:a.points[i-1][0],y:a.points[i-1][1]},end:{x:a.points[i][0],y:a.points[i][1]},thickness:a.width,color,opacity});}
    }
   }
  }
  download(await pdf.save(),state.name.replace(/\.pdf$/i,'')+'-批注.pdf','application/pdf');toast('已导出带批注的 PDF。');
 }catch(e){fail(e,'PDF 导出失败（加密文档可先导出笔记备份）');}
 finally{busy(false);}
}
let cloudBusy=false,cloudMeta=null,cloudSession=null;
async function api(path,options={}){
 const response=await fetch(path,{credentials:'same-origin',cache:'no-store',...options});
 const data=await response.json().catch(()=>({error:'云端返回了无法识别的响应'}));
 if(!response.ok){const error=new Error(data.error||'云端操作失败');error.status=response.status;throw error;}
 return data;
}
function shareNotes(){return {format:'folio-share',version:1,pageCount:state.pdf.numPages,annotations:structuredClone(state.annotations),rotation:{...state.rotation},crop:state.crop};}
function setCloudBusy(value){cloudBusy=value;$('publish-share').disabled=value||!cloudSession?.signedIn||state.shared;$('revoke-share').disabled=value;$('publish-share').textContent=value?'正在上传，请稍候…':state.shareId?'更新已发布笔记':'上传 PDF 并生成链接';}
async function openShareDialog(){
 if(!state.pdf){toast('请先打开要分享的 PDF。');return;}
 $('share-doc-name').textContent=state.name;$('share-doc-details').textContent=`${state.pdf.numPages} 页 · ${(state.bytes.length/1048576).toFixed(2)} MB · ${Object.values(state.annotations).flat().length} 条笔记`;
 if(!$('share-dialog').open)dialog('share-dialog');if(cloudBusy)return;
 $('publish-share').disabled=true;$('cloud-status').textContent='正在检查云端状态…';$('share-signin').hidden=true;$('revoke-share').hidden=true;
 $('share-signin-link').href='/signin-with-chatgpt?return_to='+encodeURIComponent(location.pathname+location.search+'#share');
 cloudSession=await api('/api/session');cloudMeta=null;
 if(state.shareId){try{cloudMeta=await api('/api/shares/'+state.shareId);}catch(e){if(e.status!==404)throw e;if(!state.shared){state.shareId=null;scheduleSave();}}}
 const hasShare=!!cloudMeta;
 $('share-link-section').hidden=!hasShare;
 if(hasShare)$('share-link').value=location.origin+'/?share='+state.shareId;
 $('share-signin').hidden=cloudSession.signedIn||state.shared;
 $('publish-share').hidden=state.shared;
 $('revoke-share').hidden=!cloudMeta?.isOwner;
 $('publish-share').disabled=!cloudSession.signedIn||!cloudSession.cloudReady||state.shared;
 $('publish-share').textContent=hasShare?'更新已发布笔记':'上传 PDF 并生成链接';
 if(!cloudSession.cloudReady)$('cloud-status').textContent='云端存储尚未就绪，请稍后再试。';
 else if(state.shared)$('cloud-status').textContent='你正在查看只读分享。可直接复制此链接；编辑请回到你自己的文档。';
 else if(hasShare)$('cloud-status').textContent=`已发布 · ${new Date(cloudMeta.updated).toLocaleString('zh-CN')}。本机新增笔记需点击更新后才对访客可见。`;
 else $('cloud-status').textContent='发布后，有此链接的人可以直接查看这份 PDF 与当前笔记，无需登录。';
}
async function publishShare(){
 if(!state.pdf||state.shared||cloudBusy)return;
 if(state.bytes.length>25*1024*1024)throw new Error('云端分享支持 25 MB 以内的 PDF；大文件仍可在本机阅读');
 const notes=shareNotes(),raw=JSON.stringify(notes);if(raw.length>2*1024*1024)throw new Error('笔记超过 2 MB，请减少笔迹后再分享');
 setCloudBusy(true);$('cloud-status').textContent=state.shareId?'正在同步当前笔记快照…':'正在上传 PDF 与笔记，首次上传需要一些时间…';
 try{
  let data;
  if(state.shareId){data=await api('/api/shares/'+state.shareId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:cloudMeta.revision,notes})});}
  else{const form=new FormData();form.append('pdf',new Blob([state.bytes],{type:'application/pdf'}),state.name);form.append('notes',raw);data=await api('/api/shares',{method:'POST',body:form});}
  state.shareId=data.id;cloudMeta={...data,isOwner:true};scheduleSave();$('share-link-section').hidden=false;$('share-link').value=data.url;$('revoke-share').hidden=false;
  $('cloud-status').textContent=`已发布成功 · ${new Date(data.updated).toLocaleString('zh-CN')}。复制链接，即可分享这份 PDF 和笔记。`;
  toast('PDF 与笔记已发布，分享链接已生成。');
 }catch(e){$('cloud-status').textContent=e.message;if(e.status===401)$('share-signin').hidden=false;throw e;}
 finally{setCloudBusy(false);}
}
async function revokeShare(){
 if(!state.shareId||cloudBusy||!cloudMeta?.isOwner)return;
 if(!confirm('撤销后，别人将无法通过这个链接打开 PDF 和笔记。你的本机原稿不会被删除。确认撤销？'))return;
 setCloudBusy(true);
 try{await api('/api/shares/'+state.shareId,{method:'DELETE'});state.shareId=null;cloudMeta=null;scheduleSave();$('share-link-section').hidden=true;$('revoke-share').hidden=true;$('cloud-status').textContent='分享已撤销，原链接不再可用。';toast('分享链接已撤销。');}
 finally{setCloudBusy(false);}
}
async function loadShared(id){
 busy(true,'正在读取云端 PDF 与笔记…');
 try{
  if(!/^[a-f0-9]{48}$/.test(id))throw new Error('分享链接格式不正确');
  const data=await api('/api/shares/'+id);const response=await fetch('/api/shares/'+id+'/pdf',{cache:'no-store',credentials:'same-origin'});if(!response.ok)throw new Error('分享不存在、已撤销或文件暂时不可用');
  await openBytes(await response.arrayBuffer(),data.name,{shared:data});
 }catch(e){$('doc-title').textContent='分享暂时无法打开';$('save-status').textContent='请联系发布者确认链接是否有效';$('pages').innerHTML=`<div class="share-unavailable"><h2>这一份分享，暂时无法打开</h2><p>${escapeHTML(e.message)}</p><a class="primary" href="/">打开我的阅读空间</a></div>`;toast(e.message,true);}
 finally{busy(false);}
}
function toggleSidebar(show){document.body.classList.toggle('sidebar-hidden',!show);render();}
function toggleNotes(show){document.body.classList.toggle('notes-hidden',!show);$('show-notes').hidden=show;render();}
// Face control. Camera frames and model results never leave the device.
let faceModel=null,stream=null,cameraStarting=false,cameraEpoch=0,cameraFrame=0,lastDetection=0,lastVideoTime=-1,gestureMode='head',baseline={yaw:0,leftEye:0,rightEye:0,leftMouth:0,rightMouth:0},calibration=null,calibrated=false;
const gestureGate=new GestureGate();
function updateCameraStatus(){const running=!!stream;const paused=running&&(state.tool!=='select'||document.hidden);$('camera-dot').classList.toggle('on',running&&!paused);$('camera-label').textContent=running?(paused?'面部翻页 · 已暂停':!calibrated?'面部翻页 · 待校准':$('gesture-test').checked?'面部翻页 · 测试中':'面部翻页 · 已开启'):'面部翻页 · 未开启';$('camera-toggle').innerHTML=icon('camera')+(running?'关闭摄像头':'开启摄像头');$('calibrate').disabled=!running;}
async function startCamera(){
 if(stream){stopCamera();return;}if(cameraStarting)return;
 cameraStarting=true;const epoch=++cameraEpoch;$('camera-toggle').disabled=true;$('camera-toggle').textContent='正在准备摄像头…';
 let acquired=null;
 try{
  if(!navigator.mediaDevices?.getUserMedia)throw new Error('请在 HTTPS 或 localhost 页面使用支持摄像头的浏览器');
  acquired=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:{ideal:640},height:{ideal:480}},audio:false});
  if(epoch!==cameraEpoch){acquired.getTracks().forEach(t=>t.stop());return;}
  $('gesture-feedback').textContent='正在加载本机识别模型，首次使用可能需要几秒钟…';
  if(!faceModel){const files=await FilesetResolver.forVisionTasks(asset('wasm'));faceModel=await FaceLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:asset('face_landmarker.task'),delegate:'CPU'},runningMode:'VIDEO',numFaces:2,outputFaceBlendshapes:true,outputFacialTransformationMatrixes:true});}
  if(epoch!==cameraEpoch){acquired.getTracks().forEach(t=>t.stop());return;}
  stream=acquired;$('camera-video').srcObject=stream;await $('camera-video').play();$('camera-placeholder').hidden=true;calibrated=false;lastVideoTime=-1;gestureGate.reset();
  $('gesture-feedback').textContent='请正对摄像头，点击“校准自然表情”。';
  for(const track of stream.getVideoTracks())track.onended=()=>stopCamera();
  cameraLoop(performance.now());
 }catch(e){acquired?.getTracks().forEach(t=>t.stop());stream=null;$('camera-video').srcObject=null;$('camera-placeholder').hidden=false;const message=e.name==='NotAllowedError'?'摄像头权限未获允许，请在浏览器地址栏中允许摄像头。':e.name==='NotFoundError'?'没有找到可用的摄像头。':e.message;$('gesture-feedback').textContent=message;toast(message,true);}
 finally{cameraStarting=false;$('camera-toggle').disabled=false;updateCameraStatus();}
}
function stopCamera(){cameraEpoch++;cancelAnimationFrame(cameraFrame);const old=stream;stream=null;old?.getTracks().forEach(t=>{t.onended=null;t.stop();});$('camera-video').srcObject=null;$('camera-placeholder').hidden=false;$('face-state').textContent='摄像头未开启';calibration=null;calibrated=false;gestureGate.reset();updateCameraStatus();}
function cameraLoop(now){
 if(!stream)return;cameraFrame=requestAnimationFrame(cameraLoop);
 if(now-lastDetection<85||document.hidden||$('camera-video').readyState<2)return;lastDetection=now;
 if(lastVideoTime===$('camera-video').currentTime)return;lastVideoTime=$('camera-video').currentTime;
 try{
  const result=faceModel.detectForVideo($('camera-video'),now);const faces=result.faceLandmarks?.length||0;
  const valid=faces===1;
  if(!valid){$('face-state').textContent=faces>1?'检测到多人 · 已暂停':'未检测到人脸 · 已暂停';gestureGate.update({valid:false},now);if(calibration){calibration.samples=[];calibration.start=now;$('gesture-feedback').textContent='请保持一张脸完整入镜，校准会重新计时。';}return;}
  const signals=getSignals(result);
  if(calibration){calibration.samples.push(signals);const elapsed=now-calibration.start;$('face-state').textContent=`校准中 · ${Math.max(0,Math.ceil((3000-elapsed)/1000))} 秒`;
   if(elapsed>=3000&&calibration.samples.length>=15){for(const key of Object.keys(baseline))baseline[key]=calibration.samples.reduce((sum,s)=>sum+s[key],0)/calibration.samples.length;calibration=null;calibrated=true;gestureGate.reset();$('gesture-feedback').textContent='校准完成。刻意做一次动作后回正，先查看测试结果。';$('calibrate').textContent='重新校准自然表情 · 约 3 秒';updateCameraStatus();}return;
  }
  if(!calibrated){$('face-state').textContent='已检测到人脸 · 请先校准';return;}
  const blocked=state.tool!=='select'||!![...document.querySelectorAll('dialog[open]')].find(d=>d.id!=='gesture-dialog');
  if(blocked){$('face-state').textContent='批注或对话框打开 · 已暂停';gestureGate.update({valid:false},now);return;}
  $('face-state').textContent='人脸已就位 · '+($('gesture-test').checked?'测试模式':'翻页已启用');
  const signalsClass=classify(signals,baseline,gestureMode,Number($('sensitivity').value));
  $('left-meter').value=Math.min(1,Math.max(0,signalsClass.leftValue));$('right-meter').value=Math.min(1,Math.max(0,signalsClass.rightValue));
  let direction=gestureGate.update({...signalsClass,valid},now,{hold:gestureMode==='wink'?280:320});
  if(direction){if($('invert-gesture').checked)direction*=-1;const label=direction>0?'下一页':'上一页';$('gesture-feedback').textContent=`${$('gesture-test').checked?'测试识别':'已触发'}：${label} · 请恢复自然表情后再做动作`;
   if(!$('gesture-test').checked){
    // The setup dialog is allowed to remain open while testing real page turns.
    const open=$('gesture-dialog').open;if(open){goPage(state.page+direction*(state.mode==='spread'?2:1));}else turn(direction);
    toast(label);
   }
  }
 }catch(e){stopCamera();fail(e,'面部识别已停止');}
}
function calibrate(){if(!stream)return;calibration={start:performance.now(),samples:[]};calibrated=false;gestureGate.reset();$('gesture-feedback').textContent='请保持自然表情，正对镜头约 3 秒，不要做翻页动作。';updateCameraStatus();}
// Bind controls.
$('open-file').onclick=$('empty-open').onclick=()=>$('file-input').click();
$('file-input').onchange=safeAction(async e=>{await openFile(e.target.files[0]);e.target.value='';},'打开文件失败');
$('load-demo').onclick=safeAction(loadDemo,'示例加载失败');
$('prev-page').onclick=()=>turn(-1);$('next-page').onclick=()=>turn(1);
$('page-number').onchange=e=>goPage(e.target.value);
$('page-number').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();goPage(e.target.value);e.target.blur();}};
document.querySelectorAll('[data-mode]').forEach(el=>el.onclick=()=>setMode(el.dataset.mode));
document.querySelectorAll('[data-tool]').forEach(el=>el.onclick=()=>setTool(el.dataset.tool));
document.querySelectorAll('[data-color]').forEach(el=>el.onclick=()=>{state.color=el.dataset.color;document.querySelectorAll('[data-color]').forEach(b=>b.classList.toggle('active',b===el));$('custom-color').value=state.color;});
$('custom-color').oninput=e=>{state.color=e.target.value;document.querySelectorAll('[data-color]').forEach(b=>b.classList.remove('active'));};
$('stroke-size').oninput=e=>{state.width=Number(e.target.value);$('stroke-label').textContent=state.width;};
$('undo').onclick=undo;$('redo').onclick=redo;
$('notes-filter').onclick=()=>{filterPage=!filterPage;$('notes-filter').textContent=filterPage?'当前页面':'全部页面';renderNotes();};
$('zoom-in').onclick=()=>{state.zoom=Math.min(3,state.zoom+.15);updateMode();render();};$('zoom-out').onclick=()=>{state.zoom=Math.max(.5,state.zoom-.15);updateMode();render();};$('zoom-reset').onclick=()=>{state.zoom=1;updateMode();render();};
$('settings-open').onclick=()=>dialog('settings-dialog');$('export-open').onclick=()=>state.pdf?dialog('export-dialog'):toast('请先打开 PDF。');$('help-open').onclick=()=>dialog('help-dialog');
$('gesture-open').onclick=$('gesture-card').onclick=()=>dialog('gesture-dialog');
$('camera-toggle').onclick=startCamera;$('calibrate').onclick=calibrate;
document.querySelectorAll('[data-gesture]').forEach(el=>el.onclick=()=>{gestureMode=el.dataset.gesture;document.querySelectorAll('[data-gesture]').forEach(b=>b.classList.toggle('active',b===el));gestureGate.reset();if(stream)calibrate();});
$('sensitivity').oninput=()=>gestureGate.reset();$('gesture-test').onchange=()=>{gestureGate.reset();updateCameraStatus();};$('invert-gesture').onchange=()=>gestureGate.reset();
$('theme').onchange=e=>{state.theme=e.target.value;document.body.classList.remove('dark','light');if(state.theme!=='paper')document.body.classList.add(state.theme);savePrefs();};
$('crop').onchange=e=>{state.crop=Number(e.target.value);scheduleSave();render();};
$('turn-step').onchange=e=>{state.turnStep=e.target.value;savePrefs();if(state.turnStep==='half')toast('半屏翻页会在页面超出屏幕时生效，可先放大页面。');};
$('rotate-page').onclick=()=>{if(!state.pdf)return;state.rotation[state.page]=((state.rotation[state.page]||0)+90)%360;scheduleSave();render();};
$('font-size').oninput=e=>{state.fontSize=Number(e.target.value);document.querySelector('.reflow-article')?.style.setProperty('--reading-size',state.fontSize+'px');savePrefs();};
$('line-height').onchange=e=>{state.lineHeight=Number(e.target.value);document.querySelector('.reflow-article')?.style.setProperty('--reading-leading',state.lineHeight);savePrefs();};
$('fullscreen').onclick=safeAction(async()=>{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();},'浏览器不支持全屏');
$('toggle-sidebar').onclick=()=>toggleSidebar(document.body.classList.contains('sidebar-hidden'));$('close-sidebar').onclick=()=>toggleSidebar(false);
$('toggle-notes').onclick=()=>toggleNotes(false);$('show-notes').onclick=()=>toggleNotes(true);
document.querySelectorAll('[data-side]').forEach(el=>el.onclick=()=>{document.querySelectorAll('[data-side]').forEach(b=>b.classList.toggle('active',b===el));['pages','outline','library'].forEach((side,i)=>$(['page-list','outline-list','library-list'][i]).hidden=side!==el.dataset.side);if(el.dataset.side==='library')renderLibrary();});
$('text-cancel').onclick=()=>closeDialog('text-dialog');$('text-form').onsubmit=e=>{e.preventDefault();if(state.shared||!typingAnchor||!$('note-text').value.trim())return;checkpoint();const {page,point}=typingAnchor;(state.annotations[page]??=[]).push({id:crypto.randomUUID(),type:'text',point,text:$('note-text').value.trim(),fontSize:Number($('note-font-size').value),color:state.color,created:Date.now()});closeDialog('text-dialog');typingAnchor=null;afterChange();};
$('export-pdf').onclick=exportPdf;$('export-backup').onclick=backup;$('import-backup').onclick=()=>$('backup-input').click();
$('backup-input').onchange=safeAction(async e=>{if(e.target.files[0])await importBackup(e.target.files[0]);e.target.value='';},'导入笔记失败');
$('share-app').onclick=safeAction(openShareDialog,'分享设置加载失败');
$('publish-share').onclick=safeAction(publishShare,'发布分享失败');
$('copy-share-link').onclick=safeAction(async()=>{await navigator.clipboard.writeText($('share-link').value);toast('文档分享链接已复制，别人打开即可查看 PDF 和笔记。');},'复制链接失败');
$('revoke-share').onclick=safeAction(revokeShare,'撤销分享失败');
$('leave-share').onclick=()=>{location.href=location.pathname;};
$('clear-local').onclick=safeAction(async()=>{if(!confirm('这会清除此阅读器在当前浏览器保存的所有 PDF 和笔记。请先导出重要笔记。确认清除？'))return;clearTimeout(saveTimer);stopCamera();await storage.clear();localStorage.removeItem('folio-last');location.reload();},'清除失败');
let dragDepth=0;
document.addEventListener('dragenter',e=>{if(e.dataTransfer?.types.includes('Files')){e.preventDefault();dragDepth++;$('drop-overlay').hidden=false;}});
document.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files'))e.preventDefault();});
document.addEventListener('dragleave',()=>{if(--dragDepth<=0){dragDepth=0;$('drop-overlay').hidden=true;}});
document.addEventListener('drop',safeAction(async e=>{e.preventDefault();dragDepth=0;$('drop-overlay').hidden=true;if(e.dataTransfer?.files[0])await openFile(e.dataTransfer.files[0]);},'拖入文件失败'));
document.addEventListener('keydown',e=>{if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||document.querySelector('dialog[open]'))return;
 if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo();return;}
 if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();redo();return;}
 if(e.key==='ArrowRight'||e.key==='PageDown'){e.preventDefault();turn(1);}if(e.key==='ArrowLeft'||e.key==='PageUp'){e.preventDefault();turn(-1);}
 const tools={p:'pen',h:'highlight',t:'text',e:'eraser',Escape:'select'};if(tools[e.key]){e.preventDefault();setTool(tools[e.key]);}
});
document.addEventListener('visibilitychange',()=>{gestureGate.reset();updateCameraStatus();if(document.hidden&&state.id){clearTimeout(saveTimer);persist();}});
$('password-dialog').addEventListener('cancel',()=>{loadingTask?.destroy();busy(false);});
window.addEventListener('pagehide',()=>{stopCamera();if(state.id)persist();});
let resizeTimer;new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>render(),200);}).observe($('workspace'));
matchMedia('(max-width: 640px)').addEventListener('change',e=>{if(e.matches)toggleSidebar(false);});
matchMedia('(max-width: 900px)').addEventListener('change',e=>{if(e.matches)toggleNotes(false);});
document.querySelectorAll('dialog').forEach(d=>{d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}});d.addEventListener('close',()=>{gestureGate.reset();if(d.id==='password-dialog'&&loadingTask&&$('pdf-password').value===''){loadingTask.destroy();busy(false);}});});
async function init(){
 Object.assign(state,prefs());$('theme').value=state.theme;$('font-size').value=state.fontSize;$('line-height').value=state.lineHeight;$('turn-step').value=state.turnStep;
 if(state.theme!=='paper')document.body.classList.add(state.theme);
 if(innerWidth<900){document.body.classList.add('notes-hidden');$('show-notes').hidden=false;}if(innerWidth<640)document.body.classList.add('sidebar-hidden');
 updateMode();renderNotes();
 const share=new URL(location.href).searchParams.get('share');if(share){await loadShared(share);return;}
 try{const last=localStorage.getItem('folio-last');if(last){const doc=await storage.getDoc(last);if(doc){await openBytes(doc.bytes,doc.name,{demo:doc.demo,knownId:doc.id});if(location.hash==='#share')await openShareDialog();return;}}}catch{}
 await loadDemo();
}
init().catch(e=>{busy(false);$('empty-state').hidden=false;fail(e,'阅读器启动失败');});
