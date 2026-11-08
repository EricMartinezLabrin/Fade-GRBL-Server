import { Injectable } from '@nestjs/common';
import { Db } from './db';
import { Secrets, hash } from './security';
import { ApiError } from './wire';
const stable=(value:unknown):string=>{
 if(Array.isArray(value)) return '['+value.map(stable).join(',')+']';
 if(value && typeof value==='object') return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+stable(v)).join(',')+'}';
 return JSON.stringify(value)??'null';
};
@Injectable()
export class Coordination {
 constructor(private readonly db:Db,private readonly secrets:Secrets) {}
 async rate(scope:string,limit:number,seconds:number) {
  const bucket=Math.floor(Date.now()/(seconds*1000)), key=this.secrets.mac('rate:'+scope+':'+bucket);
  const expiresAt=new Date((bucket+1)*seconds*1000);
  const count=await this.db.rateLimit.upsert({where:{key},create:{key,count:1,expiresAt},update:{count:{increment:1}}});
  if(count.count>limit) throw new ApiError(429,'RATE_LIMITED','Demasiados intentos.',Math.max(1,Math.ceil((expiresAt.getTime()-Date.now())/1000)));
 }
 async once<T>(userId:string,route:string,key:string|undefined,body:unknown,work:(scope:string)=>Promise<T>):Promise<T> {
  if(!key || key.length>200 || !/^[\x21-\x7e]+$/.test(key)) throw new ApiError(400,'VALIDATION_FAILED','Idempotency-Key requerido.');
  const scope=hash(userId+'\n'+route+'\n'+key), requestHash=hash(stable(body)), now=new Date();
  const decision=await this.db.locked('idem:'+scope,async tx=>{
   let old=await tx.idempotencyRecord.findUnique({where:{scope}});
   if(old && old.expiresAt<=now) { await tx.idempotencyRecord.delete({where:{scope}}); old=null; }
   if(old) {
    if(old.requestHash!==requestHash) throw new ApiError(409,'IDEMPOTENCY_CONFLICT','Clave usada con otra solicitud.');
    if(old.state==='completed') return {cached:true,value:JSON.parse(this.secrets.open(old.encryptedResponse!,scope)) as T};
    if(old.leaseUntil>now) throw new ApiError(409,'IDEMPOTENCY_CONFLICT','Solicitud todavía en curso.');
   }
   await tx.idempotencyRecord.upsert({where:{scope},create:{scope,requestHash,state:'processing',leaseUntil:new Date(Date.now()+300000),expiresAt:new Date(Date.now()+86400000)},update:{state:'processing',leaseUntil:new Date(Date.now()+300000)}});
   return {cached:false,value:undefined};
  });
  if(decision.cached) return decision.value as T;
  try {
   const result=await work(scope);
   await this.db.idempotencyRecord.update({where:{scope},data:{state:'completed',encryptedResponse:this.secrets.seal(JSON.stringify(result??null),scope)}});
   return result;
  } catch(error) {
   await this.db.idempotencyRecord.updateMany({where:{scope,state:'processing'},data:{leaseUntil:new Date(0)}}).catch(()=>undefined);
   throw error;
  }
 }
}
