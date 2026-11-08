import { Injectable } from '@nestjs/common';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, CopyObjectCommand, DeleteObjectCommand, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Config } from './config';
import { ApiError } from './wire';
import { hash } from './security';
import { randomUUID } from 'node:crypto';
export interface ObjectRef { key:string; version:string }
export interface Ticket {id:string;url:string;method:'PUT'|'GET';headers:Record<string,string>}
export abstract class ObjectStore {
 abstract ticketPut(id:string,key:string,size:number):Promise<Ticket>;
 abstract ticketGet(id:string,ref:ObjectRef):Promise<Ticket>;
 abstract put(key:string,bytes:Buffer,type:string):Promise<ObjectRef>;
 abstract read(ref:ObjectRef,max:number):Promise<Buffer>;
 abstract promote(key:string,size:number,sha:string,target:string):Promise<ObjectRef>;
 abstract removeAll(key:string):Promise<void>;
}
@Injectable()
export class S3Store extends ObjectStore {
 private readonly s3:S3Client;
 private readonly bucket:string;
 constructor(config:Config) {
  super(); this.bucket=config.required('AWS_BUCKET');
  this.s3=new S3Client({endpoint:config.required('AWS_ENDPOINT'),region:config.required('AWS_REGION'),credentials:{accessKeyId:config.required('AWS_ACCESS_KEY_ID'),secretAccessKey:config.required('AWS_SECRET_ACCESS_KEY')},requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
 }
 private fail():never { throw new ApiError(503,'STORAGE_UNAVAILABLE','Almacenamiento temporalmente indisponible.'); }
 async ticketPut(id:string,key:string,size:number):Promise<Ticket> {
  try { return {id,url:await getSignedUrl(this.s3,new PutObjectCommand({Bucket:this.bucket,Key:key,ContentType:'application/octet-stream',ContentLength:size}),{expiresIn:300}),method:'PUT',headers:{'Content-Type':'application/octet-stream'}}; } catch { return this.fail(); }
 }
 async ticketGet(id:string,ref:ObjectRef):Promise<Ticket> {
  try {return {id,url:await getSignedUrl(this.s3,new GetObjectCommand({Bucket:this.bucket,Key:ref.key,VersionId:ref.version}),{expiresIn:300}),method:'GET',headers:{}};} catch{return this.fail();}
 }
 async put(key:string,bytes:Buffer,type:string):Promise<ObjectRef> {
  try {
   const result=await this.s3.send(new PutObjectCommand({Bucket:this.bucket,Key:key,Body:bytes,ContentType:type}),{abortSignal:AbortSignal.timeout(60000)});
   if(!result.VersionId) throw new Error('Versioning required');
   return {key,version:result.VersionId};
  } catch{return this.fail();}
 }
 async read(ref:ObjectRef,max:number):Promise<Buffer> {
  try {
   const result=await this.s3.send(new GetObjectCommand({Bucket:this.bucket,Key:ref.key,VersionId:ref.version}),{abortSignal:AbortSignal.timeout(60000)});
   if(!result.Body || (result.ContentLength??max+1)>max) throw new Error('Object too large');
   const chunks:Buffer[]=[];let length=0;
   for await(const part of result.Body as AsyncIterable<Uint8Array>) {length+=part.length;if(length>max) throw new Error('Object too large');chunks.push(Buffer.from(part));}
   if(length!==result.ContentLength) throw new Error('Truncated object');
   return Buffer.concat(chunks);
  } catch{return this.fail();}
 }
 async promote(key:string,size:number,sha:string,target:string):Promise<ObjectRef> {
  try {
   const head=await this.s3.send(new HeadObjectCommand({Bucket:this.bucket,Key:key}),{abortSignal:AbortSignal.timeout(60000)});
   if(head.ContentLength!==size || !head.VersionId) throw new ApiError(409,'UPLOAD_INCOMPLETE','Carga incompleta.');
   const bytes=await this.read({key,version:head.VersionId},size);
   if(bytes.length!==size || bytes.subarray(0,4).toString('ascii')!=='FMP1' || hash(bytes)!==sha) throw new ApiError(409,'UPLOAD_INCOMPLETE','Tamaño, cabecera o hash incorrectos.');
   const result=await this.s3.send(new CopyObjectCommand({Bucket:this.bucket,Key:target,CopySource:this.bucket+'/'+key+'?versionId='+encodeURIComponent(head.VersionId),MetadataDirective:'REPLACE',ContentType:'application/octet-stream'}),{abortSignal:AbortSignal.timeout(60000)});
   if(!result.VersionId) throw new Error('Versioning required');
   return {key:target,version:result.VersionId};
  } catch(error) {
   if(error instanceof ApiError) throw error;
   if((error as {name?:string}).name==='NotFound' || (error as {name?:string}).name==='NoSuchKey') throw new ApiError(409,'UPLOAD_INCOMPLETE','Carga no encontrada.');
   return this.fail();
  }
 }
 async removeAll(key:string) {
  let KeyMarker:string|undefined,VersionIdMarker:string|undefined;
  do {
   const page=await this.s3.send(new ListObjectVersionsCommand({Bucket:this.bucket,Prefix:key,KeyMarker,VersionIdMarker}),{abortSignal:AbortSignal.timeout(60000)});
   for(const object of [...(page.Versions??[]),...(page.DeleteMarkers??[])]) if(object.Key===key && object.VersionId) await this.s3.send(new DeleteObjectCommand({Bucket:this.bucket,Key:key,VersionId:object.VersionId}),{abortSignal:AbortSignal.timeout(60000)});
   KeyMarker=page.IsTruncated?page.NextKeyMarker:undefined;VersionIdMarker=page.NextVersionIdMarker;
  } while(KeyMarker);
 }
}
export const objectKey=(kind:string)=>'fadegrbl/'+kind+'/'+randomUUID();
