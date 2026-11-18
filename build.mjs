import { build } from 'esbuild';
import { mkdir, cp, copyFile, access, readFile, writeFile, rm } from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
const projectRoot=dirname(fileURLToPath(import.meta.url));
const outputRoot=resolve('dist');
if(outputRoot!==join(projectRoot,'dist'))throw new Error('Run the build from the Folio project root');
const cachedModel=await readFile('dist/client/assets/face_landmarker.task').catch(()=>readFile('dist/assets/face_landmarker.task').catch(()=>null));
// Only the verified generated build directory is replaced.
await rm(outputRoot,{recursive:true,force:true});
const client='dist/client';
await mkdir(client+'/assets/wasm', {recursive:true});
await mkdir('dist/server',{recursive:true});
await mkdir('dist/.openai',{recursive:true});
await cp('public',client,{recursive:true});
await build({entryPoints:['src/app.js'],bundle:true,format:'esm',target:'es2022',outfile:client+'/assets/app.js',minify:true,sourcemap:false});
await build({entryPoints:['worker/index.js'],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:'dist/server/index.js',minify:true});
await copyFile('.openai/hosting.json','dist/.openai/hosting.json');
await writeFile('dist/server/wrangler.json',JSON.stringify({name:'folio-reader',main:'index.js',compatibility_date:'2026-05-15',assets:{directory:'../client',binding:'ASSETS',run_worker_first:['/api/*']},r2_buckets:[{binding:'BUCKET',bucket_name:'site-creator-r2'}]},null,2));
await copyFile('node_modules/pdfjs-dist/build/pdf.worker.min.mjs',client+'/assets/pdf.worker.min.mjs');
await cp('node_modules/pdfjs-dist/cmaps',client+'/assets/cmaps',{recursive:true});
await cp('node_modules/pdfjs-dist/standard_fonts',client+'/assets/standard_fonts',{recursive:true});
await cp('node_modules/pdfjs-dist/wasm',client+'/assets/pdf-wasm',{recursive:true});
await cp('node_modules/@mediapipe/tasks-vision/wasm',client+'/assets/wasm',{recursive:true});
await copyFile('node_modules/pdfjs-dist/web/pdf_viewer.css',client+'/assets/pdf_viewer.css');
const model=client+'/assets/face_landmarker.task';
if(cachedModel)await writeFile(model,cachedModel);
try { await access(model); } catch {
  const response=await fetch('https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task');
  if(!response.ok) throw new Error('Face model download failed: '+response.status);
  await writeFile(model,new Uint8Array(await response.arrayBuffer()));
}
const pdf=await PDFDocument.create();
const regular=await pdf.embedFont(StandardFonts.Helvetica);
const bold=await pdf.embedFont(StandardFonts.HelveticaBold);
const italic=await pdf.embedFont(StandardFonts.TimesRomanItalic);
const ink=rgb(.14,.22,.2), gray=rgb(.42,.47,.44), green=rgb(.18,.36,.29);
for(let n=1;n<=4;n++) {
 const page=pdf.addPage([595,842]);
 page.drawText('FOLIO  /  A LITTLE ROOM FOR MUSIC',{x:55,y:787,size:9,font:regular,color:gray});
 page.drawText(n===1?'A quiet afternoon':n===2?'The art of a slow page':n===3?'Room to breathe':'Make it your own',{x:55,y:739,size:29,font:italic,color:ink});
 page.drawText('READ. PLAY. LEAVE A THOUGHT.',{x:55,y:711,size:9,font:bold,color:green});
 if(n===1 || n===3){
  page.drawText(n===1?'Andante  /  q = 72':'Dolce  /  q = 64',{x:55,y:663,size:12,font:italic,color:ink});
  for(let staff=0;staff<4;staff++){
   const y=620-staff*122;
   for(let line=0;line<5;line++)page.drawLine({start:{x:55,y:y-line*9},end:{x:540,y:y-line*9},thickness:.6,color:gray});
   for(let bar=0;bar<=4;bar++)page.drawLine({start:{x:55+bar*121.25,y},end:{x:55+bar*121.25,y:y-36},thickness:.7,color:ink});
   page.drawText('4',{x:64,y:y-12,size:14,font:bold,color:ink});page.drawText('4',{x:64,y:y-29,size:14,font:bold,color:ink});
   for(let note=0;note<14;note++){
    const x=96+note*31, ny=y-9-((note*3+staff*2)%7)*4.5;
    page.drawEllipse({x,y:ny,xScale:4.5,yScale:3.1,rotate:{type:'degrees',angle:20},color:ink});
    page.drawLine({start:{x:x+4,y:ny},end:{x:x+4,y:ny+27},thickness:.9,color:ink});
   }
   page.drawText(staff===0?'p   cantabile':staff===2?'cresc.':'legato',{x:84,y:y-62,size:11,font:italic,color:gray});
  }
 }else{
  const paragraphs=n===2?[
   'A page is a small space for attention. Open a score, a book, or a paper, and let everything else become a little quieter.',
   'This reader keeps the original document close. Use page view for precise layouts, two pages for a wider desk, or comfortable reading for a simple stream of text.',
   'Try the pen to leave a mark. Circle a phrase, highlight a passage, or place a short note anywhere on the page. Your notes stay in this browser until you clear its storage.',
   'When your hands are busy, a deliberate face gesture can turn the page. Begin with calibration, find a comfortable movement, and always test before you perform.',
   'There is no need to hurry. A useful tool should leave more room for the thing you came here to do.'
  ]:[
   'Bring your own PDF. Drag a file into the reader or use the open button. Documents are processed on your device in this first version.',
   'Use the notebook panel to find every mark. Notes belong to the original page and remain in place when the page is resized or rotated.',
   'Save a notes backup to keep an editable copy. Export a marked PDF when you want to send your annotations to another reader.',
   'The camera is optional. If you enable face control, the video is processed locally. You can switch it off at any time.',
   'This is a demonstration document generated for Folio. The short musical patterns are illustrative, not a published score.'
  ];
  let y=660;
  for(const p of paragraphs){
   let line='';for(const word of p.split(' ')){if(regular.widthOfTextAtSize(line+word,13)>470){page.drawText(line.trim(),{x:55,y,size:13,font:regular,color:ink});y-=24;line='';}line+=word+' ';}
   if(line){page.drawText(line.trim(),{x:55,y,size:13,font:regular,color:ink});y-=24;}y-=20;
  }
 }
 page.drawLine({start:{x:55,y:61},end:{x:540,y:61},thickness:.5,color:gray});
 page.drawText('FOLIO DEMO  /  Original layout + your own notes',{x:55,y:43,size:8,font:regular,color:gray});
 page.drawText(String(n).padStart(2,'0'),{x:523,y:43,size:9,font:bold,color:ink});
}
await writeFile(client+'/demo.pdf',await pdf.save());
console.log('Built Folio with local PDF engine, face model, and 4-page demo.');
