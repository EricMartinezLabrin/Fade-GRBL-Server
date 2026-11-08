import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ApiError } from './wire';
@Injectable()
export class SvgProcessor {
 process(svg:string):Promise<{svg:string;thumbnail:string}> {
  if(Buffer.byteLength(svg,'utf8')>10000000) return Promise.reject(new ApiError(413,'FILE_TOO_LARGE','SVG supera 10 MB.'));
  return new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,['--max-old-space-size=128',join(__dirname,'workers','svg.cjs')],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot}});
   let length=0;const chunks:Buffer[]=[];let settled=false;
   const fail=()=>{if(!settled){settled=true;clearTimeout(timer);child.kill();reject(new ApiError(422,'SVG_INVALID','SVG inválido o demasiado complejo.'));}};
   const timer=setTimeout(fail,8000);
   child.on('error',fail);child.stdin.on('error',fail);child.stderr.on('data',()=>undefined);
   child.stdout.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>14000000)fail();else chunks.push(chunk);});
   child.on('close',code=>{if(settled)return;if(code!==0)return fail();try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8')) as {svg:string;thumbnail:string};if(typeof value.svg!=='string'||typeof value.thumbnail!=='string')return fail();settled=true;clearTimeout(timer);resolve(value);}catch{fail();}});
   child.stdin.end(svg);
  });
 }
}
