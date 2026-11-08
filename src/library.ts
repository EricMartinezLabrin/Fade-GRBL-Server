import { Injectable, Controller, Get, Post, Delete, Body, Req, Param, Query, ParseUUIDPipe, HttpCode } from '@nestjs/common';
import { Library, Upload } from '@prisma/client';
import { Db } from './db';
import { Secrets } from './security';
import { Coordination } from './coordination';
import { ObjectStore, objectKey } from './storage';
import { Tasks } from './tasks';
import { ApiError, ApiRequest, requireFound } from './wire';
import { UploadDto, MetadataDto, VersionDto, PageDto } from './dto';
const libraryModel=(r:Library)=>({id:r.id,title:r.title,tags:r.tags,description:null,category:null,updatedAt:r.updatedAt.toISOString(),version:r.version,acquisitionId:null,designId:null});
@Injectable()
export class Libraries {
 constructor(private readonly db:Db,private readonly secrets:Secrets,private readonly store:ObjectStore,private readonly tasks:Tasks) {}
 async list(ownerId:string,dto:PageDto) {
  const query=JSON.stringify(['library',ownerId]);
  const rows=await this.db.library.findMany({where:{ownerId,...this.secrets.uncursor(query,dto.cursor)},orderBy:[{createdAt:'desc'},{id:'desc'}],take:dto.limit+1});
  return this.secrets.page(rows,dto.limit,query,libraryModel);
 }
 async reserve(ownerId:string,dto:UploadDto,operationKey:string) {
  const upload=await this.db.locked('account:'+ownerId,async tx=>{
   const duplicate=await tx.upload.findUnique({where:{operationKey}});
   if(duplicate) return duplicate;
   const user=requireFound(await tx.user.findUnique({where:{id:ownerId}}));
   if(user.suspendedAt) throw new ApiError(403,'FORBIDDEN','Cuenta suspendida.');
   const old=await tx.library.findUnique({where:{ownerId_clientEntryId:{ownerId,clientEntryId:dto.clientEntryId}}});
   if(dto.libraryId) {
    if(!old || old.id!==dto.libraryId) {
     const exists=await tx.library.findFirst({where:{id:dto.libraryId,ownerId}});
     if(!exists) throw new ApiError(404,'NOT_FOUND','Respaldo no encontrado.');
     throw new ApiError(409,'VERSION_CONFLICT','Identidad local diferente.');
    }
    if(old.version!==dto.version) throw new ApiError(409,'VERSION_CONFLICT','Versión desactualizada.');
   } else if(old || dto.version!==0) throw new ApiError(409,'VERSION_CONFLICT','Consulta nube para reconciliar respaldo.');
   if(user.usedBytes+user.reservedBytes+dto.sizeBytes>user.quotaBytes) throw new ApiError(507,'QUOTA_EXCEEDED','No hay espacio privado suficiente.');
   const stagingKey=objectKey('staging');
   const row=await tx.upload.create({data:{ownerId,operationKey,clientEntryId:dto.clientEntryId,libraryId:dto.libraryId,expectedVersion:dto.version,sizeBytes:dto.sizeBytes,sha256:dto.sha256,stagingKey,expiresAt:new Date(Date.now()+900000)}});
   await tx.user.update({where:{id:ownerId},data:{reservedBytes:{increment:dto.sizeBytes}}});
   await this.tasks.enqueue(tx,'gc',{key:stagingKey},new Date(Date.now()+960000));
   return row;
  });
  if(upload.state!=='reserved'||upload.expiresAt<=new Date()) throw new ApiError(409,'UPLOAD_INCOMPLETE','Reserva vencida o finalizada.');
  return this.store.ticketPut(upload.id,upload.stagingKey,upload.sizeBytes);
 }
 private async owned(ownerId:string,id:string):Promise<Upload> {return requireFound(await this.db.upload.findFirst({where:{id,ownerId}}));}
 async complete(ownerId:string,id:string,dto:MetadataDto) {
  const upload=await this.owned(ownerId,id);
  if(upload.state==='completed') return upload.completedResult;
  if(upload.state!=='reserved'||upload.expiresAt<=new Date()) throw new ApiError(409,'UPLOAD_INCOMPLETE','Reserva no disponible.');
  const finalKey=objectKey('library');
  await this.tasks.planObject(finalKey);
  const final=await this.store.promote(upload.stagingKey,upload.sizeBytes,upload.sha256,finalKey);
  return this.db.locked('account:'+ownerId,async tx=>{
   const current=requireFound(await tx.upload.findFirst({where:{id,ownerId}}));
   if(current.state==='completed') return current.completedResult;
   if(current.state!=='reserved'||current.expiresAt<=new Date()) throw new ApiError(409,'UPLOAD_INCOMPLETE','Reserva no disponible.');
   const user=requireFound(await tx.user.findUnique({where:{id:ownerId}}));
   if(user.suspendedAt) throw new ApiError(403,'FORBIDDEN','Cuenta suspendida.');
   const old=await tx.library.findUnique({where:{ownerId_clientEntryId:{ownerId,clientEntryId:current.clientEntryId}}});
   if((old?.id??null)!==(current.libraryId??null)||(old?.version??0)!==current.expectedVersion) throw new ApiError(409,'VERSION_CONFLICT','Respaldo modificado por otra solicitud.');
   const data={title:dto.title.trim(),tags:dto.tags,objectKey:final.key,objectVersion:final.version,sizeBytes:current.sizeBytes};
   const row=old?await tx.library.update({where:{id:old.id},data:{...data,version:{increment:1}}}):await tx.library.create({data:{...data,ownerId,clientEntryId:current.clientEntryId}});
   await tx.user.update({where:{id:ownerId},data:{reservedBytes:{decrement:current.sizeBytes},usedBytes:{increment:current.sizeBytes-(old?.sizeBytes??0)}}});
   const result=libraryModel(row);
   await tx.upload.update({where:{id},data:{state:'completed',completedResult:result}});
   await this.tasks.enqueue(tx,'gc',{key:current.stagingKey});
   if(old)await this.tasks.enqueue(tx,'gc',{key:old.objectKey});
   return result;
  });
 }
 async cancel(ownerId:string,id:string) {
  await this.db.locked('account:'+ownerId,async tx=>{
   const upload=requireFound(await tx.upload.findFirst({where:{id,ownerId}}));
   if(upload.state!=='reserved')return;
   await tx.user.update({where:{id:ownerId},data:{reservedBytes:{decrement:upload.sizeBytes}}});
   await tx.upload.update({where:{id},data:{state:'canceled'}});
   await this.tasks.enqueue(tx,'gc',{key:upload.stagingKey});
  });
 }
 async content(ownerId:string,id:string) {
  const row=requireFound(await this.db.library.findFirst({where:{id,ownerId}}));
  return this.store.ticketGet(id,{key:row.objectKey,version:row.objectVersion});
 }
 async remove(ownerId:string,id:string,version:number) {
  await this.db.locked('account:'+ownerId,async tx=>{
   const row=requireFound(await tx.library.findFirst({where:{id,ownerId}}));
   if(row.version!==version)throw new ApiError(409,'VERSION_CONFLICT','Versión desactualizada.');
   await tx.library.delete({where:{id}});
   await tx.user.update({where:{id:ownerId},data:{usedBytes:{decrement:row.sizeBytes}}});
   await this.tasks.enqueue(tx,'gc',{key:row.objectKey});
  });
 }
}
@Controller()
export class LibraryController {
 constructor(private readonly libraries:Libraries,private readonly coordination:Coordination) {}
 @Get('library') list(@Req() req:ApiRequest,@Query() dto:PageDto){return this.libraries.list(req.actor.id,dto);}
 @Post('uploads') reserve(@Req() req:ApiRequest,@Body() dto:UploadDto){return this.coordination.once(req.actor.id,'POST /uploads',req.header('Idempotency-Key'),dto,key=>this.libraries.reserve(req.actor.id,dto,key));}
 @Post('uploads/:id/complete') @HttpCode(200) complete(@Req() req:ApiRequest,@Param('id',ParseUUIDPipe) id:string,@Body() dto:MetadataDto){return this.coordination.once(req.actor.id,'POST /uploads/'+id+'/complete',req.header('Idempotency-Key'),dto,()=>this.libraries.complete(req.actor.id,id,dto));}
 @Delete('uploads/:id') @HttpCode(204) async cancel(@Req() req:ApiRequest,@Param('id',ParseUUIDPipe) id:string){await this.libraries.cancel(req.actor.id,id);}
 @Post('library/:id/content') @HttpCode(200) content(@Req() req:ApiRequest,@Param('id',ParseUUIDPipe) id:string){return this.libraries.content(req.actor.id,id);}
 @Delete('library/:id') @HttpCode(204) async remove(@Req() req:ApiRequest,@Param('id',ParseUUIDPipe) id:string,@Body() dto:VersionDto){await this.libraries.remove(req.actor.id,id,dto.version);}
}
