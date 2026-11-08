'use strict';
const {SaxesParser}=require('saxes');
const svgpath=require('svgpath');
const {Resvg}=require('@resvg/resvg-js');
const MAX=1000000,NS='http://www.w3.org/2000/svg';
let pointCount=0;
const finite=n=>{n=Number(n);if(!Number.isFinite(n)||Math.abs(n)>1e6)throw Error('coordinate');return n;};
const number=(s,fallback=0)=>s===undefined?fallback:(/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(s.trim())?finite(s):(()=>{throw Error('number')})());
const nums=s=>{const parts=s.trim().split(/[\s,]+/);return parts.map(x=>number(x));};
const identity=[1,0,0,1,0,0];
const mul=(a,b)=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
function transform(s=''){
 let result=identity,remaining=s;
 const re=/^\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^()]*)\)\s*,?/;
 while(remaining.trim()){
  const match=re.exec(remaining);if(!match)throw Error('transform');const v=nums(match[2]);let m;
  switch(match[1]){
   case'matrix':if(v.length!==6)throw Error();m=v;break;
   case'translate':if(v.length<1||v.length>2)throw Error();m=[1,0,0,1,v[0],v[1]||0];break;
   case'scale':if(v.length<1||v.length>2)throw Error();m=[v[0],0,0,v[1]??v[0],0,0];break;
   case'rotate':{if(v.length!==1&&v.length!==3)throw Error();const r=v[0]*Math.PI/180,c=Math.cos(r),s=Math.sin(r);m=[c,s,-s,c,0,0];if(v.length===3)m=mul(mul([1,0,0,1,v[1],v[2]],m),[1,0,0,1,-v[1],-v[2]]);break;}
   case'skewX':if(v.length!==1)throw Error();m=[1,0,Math.tan(v[0]*Math.PI/180),1,0,0];break;
   case'skewY':if(v.length!==1)throw Error();m=[1,Math.tan(v[0]*Math.PI/180),0,1,0,0];break;
  }
  if(m.some(n=>!Number.isFinite(n)))throw Error();result=mul(result,m);remaining=remaining.slice(match[0].length);
 }
 return result;
}
function length(s,fallback){if(s===undefined)return fallback;const m=/^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(mm|cm|in|pt|pc|px)?$/i.exec(s.trim());if(!m)throw Error();const n=finite(m[1]);return n*({mm:1,cm:10,in:25.4,pt:25.4/72,pc:25.4/6,px:25.4/96}[m[2]?.toLowerCase()||'px']);}
const color=s=>{s=s.trim().toLowerCase();if(!/^(none|#[a-f0-9]{3,8}|[a-z]{1,24}|rgba?\([\d.,%\s]+\))$/.test(s))throw Error('color');return s;};
const esc=s=>s.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const n=x=>{finite(x);return String(Number(x.toFixed(6)));};
function flatten(data,matrix){
 const p=svgpath(data);if(p.err)throw Error(p.err);p.abs().unshort().unarc().matrix(matrix).abs();
 const output=[];let x=0,y=0,startX=0,startY=0;
 const emit=(x,y,move=false)=>{if(++pointCount>MAX)throw Error('points');finite(x);finite(y);output.push((move?'M':'L')+n(x)+' '+n(y));};
 const distance=(px,py,ax,ay,bx,by)=>{const dx=bx-ax,dy=by-ay;return Math.hypot(dx,dy)<1e-12?Math.hypot(px-ax,py-ay):Math.abs(dy*px-dx*py+bx*ay-by*ax)/Math.hypot(dx,dy);};
 const cubic=(a,b,c,d,depth=0)=>{
  if(depth>24)throw Error('curve');
  if(Math.max(distance(...b,...a,...d),distance(...c,...a,...d))<=0.025){emit(...d);return;}
  const mid=(a,b)=>[(a[0]+b[0])/2,(a[1]+b[1])/2],ab=mid(a,b),bc=mid(b,c),cd=mid(c,d),abc=mid(ab,bc),bcd=mid(bc,cd),center=mid(abc,bcd);
  cubic(a,ab,abc,center,depth+1);cubic(center,bcd,cd,d,depth+1);
 };
 p.iterate(seg=>{
  const cmd=seg[0].toUpperCase();
  if(cmd==='M'){x=seg[1];y=seg[2];startX=x;startY=y;emit(x,y,true);}
  else if(cmd==='L'){x=seg[1];y=seg[2];emit(x,y);}
  else if(cmd==='H'){x=seg[1];emit(x,y);}
  else if(cmd==='V'){y=seg[1];emit(x,y);}
  else if(cmd==='C'){cubic([x,y],[seg[1],seg[2]],[seg[3],seg[4]],[seg[5],seg[6]]);x=seg[5];y=seg[6];}
  else if(cmd==='Q'){const qx=seg[1],qy=seg[2],ex=seg[3],ey=seg[4];cubic([x,y],[x+2*(qx-x)/3,y+2*(qy-y)/3],[ex+2*(qx-ex)/3,ey+2*(qy-ey)/3],[ex,ey]);x=ex;y=ey;}
  else if(cmd==='Z'){output.push('Z');x=startX;y=startY;}
  else throw Error('path command');
 });
 return output.join(' ');
}
const common=['id','transform','fill','stroke','stroke-width','opacity','fill-opacity','stroke-opacity','display','visibility','fill-rule','stroke-linecap','stroke-linejoin','stroke-miterlimit'];
const attrs={
 svg:['xmlns','version','width','height','viewBox','preserveAspectRatio',...common],
 g:common,path:[...common,'d'],rect:[...common,'x','y','width','height','rx','ry'],
 circle:[...common,'cx','cy','r'],ellipse:[...common,'cx','cy','rx','ry'],
 line:[...common,'x1','y1','x2','y2'],polyline:[...common,'points'],polygon:[...common,'points'],title:[],desc:[]
};
function shape(tag,a){
 const v=k=>number(a[k]);
 if(tag==='path')return a.d||'';
 if(tag==='line')return 'M'+v('x1')+' '+v('y1')+'L'+v('x2')+' '+v('y2');
 if(tag==='polyline'||tag==='polygon'){
  const p=nums(a.points||'');if(p.length<4||p.length%2)throw Error();
  return 'M'+p[0]+' '+p[1]+p.slice(2).map((x,i)=>(i%2?' ':'L')+x).join('')+(tag==='polygon'?'Z':'');
 }
 if(tag==='circle'||tag==='ellipse'){
  const cx=v('cx'),cy=v('cy'),rx=tag==='circle'?v('r'):v('rx'),ry=tag==='circle'?rx:v('ry');if(rx<=0||ry<=0)throw Error();
  return 'M'+(cx-rx)+' '+cy+'A'+rx+' '+ry+' 0 1 0 '+(cx+rx)+' '+cy+'A'+rx+' '+ry+' 0 1 0 '+(cx-rx)+' '+cy+'Z';
 }
 const x=v('x'),y=v('y'),w=v('width'),h=v('height');if(w<=0||h<=0)throw Error();
 let rx=number(a.rx,a.ry===undefined?0:v('ry')),ry=number(a.ry,rx);if(rx<0||ry<0)throw Error();rx=Math.min(rx,w/2);ry=Math.min(ry,h/2);
 if(!rx||!ry)return 'M'+x+' '+y+'h'+w+'v'+h+'h'+(-w)+'Z';
 return 'M'+(x+rx)+' '+y+'H'+(x+w-rx)+'A'+rx+' '+ry+' 0 0 1 '+(x+w)+' '+(y+ry)+'V'+(y+h-ry)+'A'+rx+' '+ry+' 0 0 1 '+(x+w-rx)+' '+(y+h)+'H'+(x+rx)+'A'+rx+' '+ry+' 0 0 1 '+x+' '+(y+h-ry)+'V'+(y+ry)+'A'+rx+' '+ry+' 0 0 1 '+(x+rx)+' '+y+'Z';
}
function processSvg(source){
 if(Buffer.byteLength(source)>1e7)throw Error();let count=0,width,height,rootMatrix,rootSeen=false;
 const stack=[],output=[];
 const parser=new SaxesParser({xmlns:true});
 parser.on('doctype',()=>{throw Error('doctype');});parser.on('processinginstruction',()=>{throw Error('processing instruction');});
 parser.on('opentag',tag=>{
  const name=tag.local;if(tag.uri!==NS||!attrs[name]||++count>50000||stack.length>=64)throw Error('element');
  if(stack.length===0){if(rootSeen||name!=='svg')throw Error();rootSeen=true;}else if(name==='svg')throw Error('nested SVG');
  const a={};for(const attribute of Object.values(tag.attributes)){if(attribute.name==='xmlns'&&attribute.value===NS){a.xmlns=NS;continue;}if(attribute.prefix||!attrs[name].includes(attribute.local)||/url\s*\(|javascript:|data:/i.test(attribute.value))throw Error('attribute');a[attribute.local]=attribute.value;}
  if(stack.length===0){
   const vb=a.viewBox?nums(a.viewBox):null;if(vb&&(vb.length!==4||vb[2]<=0||vb[3]<=0))throw Error('viewbox');
   width=length(a.width,vb?vb[2]*25.4/96:undefined);height=length(a.height,vb?vb[3]*25.4/96:undefined);
   if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||width>1e6||height>1e6)throw Error('dimensions');
   const box=vb||[0,0,width*96/25.4,height*96/25.4];let sx=width/box[2],sy=height/box[3],ox=0,oy=0;
   const aspect=a.preserveAspectRatio||'xMidYMid meet';if(aspect!=='none'){const m=/^(xMin|xMid|xMax)(YMin|YMid|YMax)(?: (meet|slice))?$/.exec(aspect);if(!m)throw Error('aspect');const s=m[3]==='slice'?Math.max(sx,sy):Math.min(sx,sy);sx=sy=s;ox=(width-box[2]*s)*(m[1]==='xMin'?0:m[1]==='xMid'?.5:1);oy=(height-box[3]*s)*(m[2]==='YMin'?0:m[2]==='YMid'?.5:1);}
   rootMatrix=[sx,0,0,sy,ox-box[0]*sx,oy-box[1]*sy];
   output.push('<svg xmlns="'+NS+'" width="'+n(width)+'mm" height="'+n(height)+'mm" viewBox="0 0 '+n(width)+' '+n(height)+'">');
  }
  const parent=stack[stack.length-1]||{matrix:rootMatrix,fill:'black',stroke:'none',hidden:false};
  const current={matrix:mul(parent.matrix,transform(a.transform)),fill:color(a.fill??parent.fill),stroke:color(a.stroke??parent.stroke),hidden:parent.hidden||a.display==='none'||a.visibility==='hidden'||a.opacity==='0',name};
  stack.push(current);
  if(name==='g')output.push('<g id="g'+count+'">');
  else if(!['svg','title','desc'].includes(name)&&!current.hidden){
   const d=flatten(shape(name,a),current.matrix);if(!d)return;
   const opacity=a.opacity===undefined?1:number(a.opacity);if(opacity<0||opacity>1)throw Error('opacity');
   output.push('<path d="'+d+'" fill="'+esc(current.fill)+'" stroke="'+esc(current.stroke)+'" stroke-width="0.1" opacity="'+n(opacity)+'"/>');
  }
 });
 parser.on('closetag',()=>{const item=stack.pop();if(item?.name==='g')output.push('</g>');if(item?.name==='svg')output.push('</svg>');});
 parser.write(source).close();if(!rootSeen||pointCount<2)throw Error('empty');
 const svg=output.join('');if(Buffer.byteLength(svg)>1e7)throw Error('canonical size');
 const thumb=svg.replace(/^<svg[^>]*>/,'<svg xmlns="'+NS+'" width="240" height="240" viewBox="0 0 '+n(width)+' '+n(height)+'">');
 const png=new Resvg(thumb,{background:'white',font:{loadSystemFonts:false}}).render().asPng();if(png.length>262144)throw Error('thumbnail');
 return {svg,thumbnail:Buffer.from(png).toString('base64')};
}
let source='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{source+=s;if(Buffer.byteLength(source)>1e7)process.exit(2);});
process.stdin.on('end',()=>{try{process.stdout.write(JSON.stringify(processSvg(source)));}catch{process.exitCode=2;}});
