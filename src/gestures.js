// Hold + release + cooldown prevents natural motions and sustained poses from repeating.
export class GestureGate {
 constructor(){this.reset();}
 reset(){this.candidate=0;this.since=0;this.armed=false;this.neutralSince=null;this.last=-Infinity;}
 update({left,right,neutral,valid=true},now,{hold=260,cooldown=1100,release=300}={}){
  if(!valid){this.candidate=0;this.since=0;this.armed=false;this.neutralSince=null;return 0;}
  if(neutral){this.candidate=0;this.neutralSince??=now;if(now-this.neutralSince>=release)this.armed=true;return 0;}
  this.neutralSince=null;
  const dir=left&&!right?-1:right&&!left?1:0;
  if(!dir){this.candidate=0;return 0;}
  if(!this.armed||now-this.last<cooldown){this.candidate=0;return 0;}
  if(dir!==this.candidate){this.candidate=dir;this.since=now;return 0;}
  if(now-this.since<hold)return 0;
  this.last=now;this.armed=false;this.candidate=0;return dir;
 }
}
export function getSignals(result){
 const scores=Object.fromEntries((result.faceBlendshapes?.[0]?.categories||[]).map(x=>[x.categoryName,x.score]));
 const matrix=result.facialTransformationMatrixes?.[0]?.data;
 return {yaw:matrix?Math.atan2(matrix[8],matrix[10])*180/Math.PI:0,leftEye:scores.eyeBlinkLeft||0,rightEye:scores.eyeBlinkRight||0,leftMouth:Math.max(scores.mouthLeft||0,scores.mouthSmileLeft||0),rightMouth:Math.max(scores.mouthRight||0,scores.mouthSmileRight||0)};
}
export function classify(signals,baseline,mode,sensitivity=5){
 const threshold=(11-sensitivity)/10;
 if(mode==='head'){
  const y=signals.yaw-baseline.yaw,t=8+threshold*20;
  return {left:y<-t,right:y>t,neutral:Math.abs(y)<t*.45,leftValue:Math.max(0,-y/t),rightValue:Math.max(0,y/t)};
 }
 if(mode==='wink'){
  const l=signals.leftEye-baseline.leftEye,r=signals.rightEye-baseline.rightEye,t=.32+threshold*.32;
  return {left:l>t&&r<.25,right:r>t&&l<.25,neutral:l<.2&&r<.2,leftValue:l/t,rightValue:r/t};
 }
 const l=signals.leftMouth-baseline.leftMouth,r=signals.rightMouth-baseline.rightMouth,t=.15+threshold*.28;
 return {left:l>t&&l-r>.12,right:r>t&&r-l>.12,neutral:l<t*.45&&r<t*.45,leftValue:l/t,rightValue:r/t};
}
