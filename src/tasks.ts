import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { Db, Tx } from './db';
import { Secrets } from './security';
import { Config } from './config';
import { ObjectStore } from './storage';
@Injectable()
export class Tasks implements OnModuleInit,OnModuleDestroy {
 private timer?:NodeJS.Timeout;private running=false;private readonly worker=randomUUID();
 constructor(private readonly db:Db,private readonly secrets:Secrets,private readonly config:Config,private readonly storage:ObjectStore) {}
 onModuleInit() { if(!this.config.test && this.config.env.JOBS_ENABLED!=='false') {this.timer=setInterval(()=>{void this.tick().catch(()=>undefined);},2000);this.timer.unref();} }
 onModuleDestroy() {if(this.timer) clearInterval(this.timer);}
 async enqueue(tx:Tx,kind:string,payload:unknown,availableAt=new Date()) {
  const id=randomUUID();
  return tx.task.create({data:{id,kind,encryptedPayload:this.secrets.seal(JSON.stringify(payload),'task:'+id),availableAt}});
 }
 async planObject(key:string,availableAt=new Date(Date.now()+86400000)) {
  return this.db.$transaction(tx=>this.enqueue(tx,'gc',{key},availableAt));
 }
 async expire() {
  const expired=await this.db.upload.findMany({where:{state:'reserved',expiresAt:{lte:new Date()}},take:50});
  for(const entry of expired) await this.db.locked('account:'+entry.ownerId,async tx=>{
   const upload=await tx.upload.findUnique({where:{id:entry.id}});
   if(!upload || upload.state!=='reserved' || upload.expiresAt>new Date()) return;
   await tx.user.update({where:{id:upload.ownerId},data:{reservedBytes:{decrement:upload.sizeBytes}}});
   await tx.upload.update({where:{id:upload.id},data:{state:'expired'}});
   await this.enqueue(tx,'gc',{key:upload.stagingKey});
  });
  await this.db.rateLimit.deleteMany({where:{expiresAt:{lt:new Date(Date.now()-86400000)}}});
  await this.db.idempotencyRecord.deleteMany({where:{expiresAt:{lt:new Date()},state:'completed'}});
 }
 async tick() {
  if(this.running) return; this.running=true;
  try {
   await this.expire();
   const task=await this.db.$transaction(async tx=>{
    const rows=await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM "Task" WHERE "completedAt" IS NULL AND "availableAt" <= now() AND ("lockedUntil" IS NULL OR "lockedUntil" < now()) ORDER BY "availableAt" LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if(!rows.length) return null;
    return tx.task.update({where:{id:rows[0].id},data:{lockOwner:this.worker,lockedUntil:new Date(Date.now()+120000),attempts:{increment:1}}});
   });
   if(!task) return;
   try {
    const payload=JSON.parse(this.secrets.open(task.encryptedPayload,'task:'+task.id)) as {to?:string;subject?:string;text?:string;key?:string};
    if(task.kind==='mail') {
     const mail=nodemailer.createTransport({host:this.config.required('SMTP_HOST'),port:this.config.int('SMTP_PORT',587),secure:this.config.env.SMTP_SECURE==='true',auth:this.config.env.SMTP_USER?{user:this.config.env.SMTP_USER,pass:this.config.required('SMTP_PASSWORD')}:undefined,connectionTimeout:10000,socketTimeout:30000});
     try {await mail.sendMail({from:this.config.required('SMTP_FROM'),to:payload.to,subject:payload.subject,text:payload.text});} finally {mail.close();}
    } else if(task.kind==='gc') {
     const key=payload.key!;
     const referenced=await this.db.library.count({where:{objectKey:key}})+await this.db.design.count({where:{OR:[{svgKey:key},{thumbnailKey:key}]}});
     const pending=await this.db.upload.count({where:{stagingKey:key,state:'reserved',expiresAt:{gt:new Date()}}});
     if(pending) throw new Error('Pending object');
     if(!referenced) await this.storage.removeAll(key);
    } else throw new Error('Unknown task');
    await this.db.task.updateMany({where:{id:task.id,lockOwner:this.worker},data:{completedAt:new Date(),lockedUntil:null,lockOwner:null,encryptedPayload:this.secrets.seal('{}','task:'+task.id),lastError:null}});
   } catch {
    await this.db.task.updateMany({where:{id:task.id,lockOwner:this.worker},data:{availableAt:new Date(Date.now()+Math.min(3600000,1000*2**Math.min(task.attempts,12))),lockedUntil:null,lockOwner:null,lastError:'TASK_FAILED'}});
   }
  } finally {this.running=false;}
 }
}
