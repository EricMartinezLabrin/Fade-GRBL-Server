import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, sign, timingSafeEqual } from 'node:crypto';
import { Config } from './config';
import { ApiError } from './wire';
export const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export const normalized=(value:string)=>value.normalize('NFC').trim().toLowerCase();
@Injectable()
export class Secrets {
 constructor(private readonly config:Config) {}
 seal(value:string,context:string) {
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',this.config.encryptionKey,iv);
  cipher.setAAD(Buffer.from(context));
  const bytes=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64');
 }
 open(value:string,context:string) {
  const bytes=Buffer.from(value,'base64'), decipher=createDecipheriv('aes-256-gcm',this.config.encryptionKey,bytes.subarray(0,12));
  decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(bytes.subarray(12,28));
  return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');
 }
 mac(value:string) { return createHmac('sha256',this.config.encryptionKey).update(value).digest('base64url'); }
 receipt(claim:{accountId:string;designId:string;acquisitionId:string;sha256:string;licenseVersion:string}) {
  const bytes=Buffer.from(JSON.stringify(claim),'utf8');
  return {payload:bytes.toString('base64'),signature:sign('RSA-SHA256',bytes,this.config.privateKey).toString('base64')};
 }
 cursor(query:string,row:{createdAt:Date;id:string}) {
  const payload=Buffer.from(JSON.stringify({query,at:row.createdAt.toISOString(),id:row.id})).toString('base64url');
  return payload+'.'+this.mac('cursor:'+payload);
 }
 uncursor(query:string,cursor?:string) {
  if (!cursor) return undefined;
  try {
   const [payload,signature,extra]=cursor.split('.');
   const expected=Buffer.from(this.mac('cursor:'+payload)), received=Buffer.from(signature??'');
   if(extra || expected.length!==received.length || !timingSafeEqual(expected,received)) throw new Error();
   const parsed=JSON.parse(Buffer.from(payload,'base64url').toString('utf8')) as {query:string;at:string;id:string};
   if(parsed.query!==query || !/^[a-f0-9-]{36}$/.test(parsed.id) || !Number.isFinite(Date.parse(parsed.at))) throw new Error();
   return {OR:[{createdAt:{lt:new Date(parsed.at)}},{createdAt:new Date(parsed.at),id:{lt:parsed.id}}]};
  } catch { throw new ApiError(400,'VALIDATION_FAILED','Cursor inválido.'); }
 }
 page<T extends {createdAt:Date;id:string}>(rows:T[],limit:number,query:string,map:(row:T)=>unknown) {
  const items=rows.slice(0,limit);
  return {items:items.map(map),nextCursor:rows.length>limit?this.cursor(query,items[items.length-1]):null};
 }
}
