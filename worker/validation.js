export const MAX_PDF=25*1024*1024;
export function validateNotes(input){
 if(!input||input.format!=='folio-share'||input.version!==1||!Number.isInteger(input.pageCount)||input.pageCount<1||input.pageCount>10000)throw new Error('文档信息无效');
 const annotations=input.annotations;if(!annotations||typeof annotations!=='object'||Array.isArray(annotations))throw new Error('笔记格式无效');
 let count=0,totalPoints=0;
 const point=p=>Array.isArray(p)&&p.length===2&&p.every(v=>Number.isFinite(v)&&Math.abs(v)<100000);
 for(const [page,list]of Object.entries(annotations)){
  if(!/^\d+$/.test(page)||+page<1||+page>input.pageCount||!Array.isArray(list))throw new Error('笔记页码无效');
  for(const a of list){
   if(++count>20000||!a||!['pen','highlight','text'].includes(a.type)||typeof a.id!=='string'||a.id.length>100||!/^#[a-f0-9]{6}$/i.test(a.color)||!Number.isFinite(a.created))throw new Error('笔记数据无效');
   if(a.type==='text'){
    if(typeof a.text!=='string'||a.text.length>2000||!point(a.point)||!Number.isFinite(a.fontSize)||a.fontSize<1||a.fontSize>100)throw new Error('文字笔记无效');
   }else{
    if(!Array.isArray(a.points)||a.points.length<1||!a.points.every(point)||!Number.isFinite(a.width)||a.width<=0||a.width>200)throw new Error('笔迹数据无效');
    totalPoints+=a.points.length;if(totalPoints>500000)throw new Error('笔迹数据过大，请减少笔记后再分享');
   }
  }
 }
 const rotation={};for(const [p,angle]of Object.entries(input.rotation||{})){if(!/^\d+$/.test(p)||+p<1||+p>input.pageCount||![0,90,180,270].includes(angle))throw new Error('页面方向无效');rotation[p]=angle;}
 const crop=Number(input.crop)||0;if(![0,3,6,9].includes(crop))throw new Error('页面裁边无效');
 return {format:'folio-share',version:1,pageCount:input.pageCount,annotations,rotation,crop};
}
