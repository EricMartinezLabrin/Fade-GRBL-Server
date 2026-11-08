import { Injectable, Controller, Get, Post, Patch, Delete, Req, Body, Query, Param, ParseUUIDPipe, HttpCode } from '@nestjs/common';
import { Design, Acquisition } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Db } from './db';
import { Secrets, hash, normalized } from './security';
import { Coordination } from './coordination';
import { ObjectStore, objectKey } from './storage';
import { Tasks } from './tasks';
import { SvgProcessor } from './svg';
import { Config, LICENSE, LICENSE_TEXT } from './config';
import { ApiRequest, ApiError, requireFound, publicUser, Roles } from './wire';
import { PageDto, PublishDto, EditDesignDto, AcquireDto, VersionDto, ReportDto, ReasonDto, ResolveDto } from './dto';
@Injectable()
export class Market {
 constructor(private readonly db:Db,private readonly secrets:Secrets,private readonly storage:ObjectStore,private readonly tasks:Tasks,private readonly svg:SvgProcessor,private readonly config:Config) {}
 async model(row:Design) {
  const designer=publicUser(requireFound(await this.db.user.findUnique({where:{id:row.ownerId}})));
  return {id:row.id,title:row.title,description:row.description,category:row.category,tags:row.tags,designer,licenseVersion:row.licenseVersion,status:row.blockedAt?'blocked':row.withdrawnAt?'withdrawn':'published',version:row.version,sha256:row.sha256,thumbnail:row.thumbnail};
 }
 async list(dto:PageDto) {
  const search=normalized(dto.q??''),category=normalized(dto.category??''),query=JSON.stringify(['designs',search,category,dto.designerId??'']);
  const rows=await this.db.design.findMany({where:{withdrawnAt:null,blockedAt:null,ownerId:dto.designerId,searchText:search?{contains:search}:undefined,categoryKey:category||undefined,...this.secrets.uncursor(query,dto.cursor)},orderBy:[{createdAt:'desc'},{id:'desc'}],take:dto.limit+1});
  const page=this.secrets.page(rows,dto.limit,query,r=>r);
  return {...page,items:await Promise.all(rows.slice(0,dto.limit).map(r=>this.model(r)))};
 }
 async detail(id:string,ownerId:string) {
  const row=requireFound(await this.db.design.findUnique({where:{id}}));
  if((row.blockedAt||row.withdrawnAt)&&row.ownerId!==ownerId)throw new ApiError(404,'NOT_FOUND','Diseño no encontrado.');
  return this.model(row);
 }
 async publish(ownerId:string,dto:PublishDto,operationKey:string) {
  if(dto.price!==0)throw new ApiError(422,'PAYMENTS_NOT_ENABLED','Publicaciones de pago no disponibles.');
  if(dto.licenseVersion!==LICENSE)throw new ApiError(422,'LICENSE_INVALID','Licencia no válida.');
  if(!dto.ownershipConfirmed)throw new ApiError(422,'VALIDATION_FAILED','Confirma autoría.');
  const existing=await this.db.design.findUnique({where:{operationKey}});if(existing)return this.model(existing);
  const owner=requireFound(await this.db.user.findUnique({where:{id:ownerId}}));
  if(!owner.emailVerified)throw new ApiError(403,'EMAIL_NOT_VERIFIED','Verifica correo antes de publicar.');
  const prepared=await this.svg.process(dto.svg),sha256=hash(prepared.svg),svgKey=objectKey('designs'),thumbnailKey=objectKey('thumbnails');
  await this.tasks.planObject(svgKey);await this.tasks.planObject(thumbnailKey);
  const original=await this.storage.put(svgKey,Buffer.from(prepared.svg,'utf8'),'image/svg+xml');
  const thumbnail=await this.storage.put(thumbnailKey,Buffer.from(prepared.thumbnail,'base64'),'image/png');
  const row=await this.db.locked('account:'+ownerId,async tx=>{
   const replay=await tx.design.findUnique({where:{operationKey}});if(replay)return replay;
   const user=requireFound(await tx.user.findUnique({where:{id:ownerId}}));
   if(user.suspendedAt||!user.emailVerified)throw new ApiError(403,'FORBIDDEN','Cuenta no habilitada.');
   const duplicate=await tx.design.findUnique({where:{ownerId_sha256:{ownerId,sha256}}});if(duplicate)throw new ApiError(409,'VERSION_CONFLICT','Ya publicaste este diseño.');
   const today=new Date();today.setUTCHours(0,0,0,0);
   const daily=await tx.design.count({where:{ownerId,createdAt:{gte:today}}}),active=await tx.design.count({where:{ownerId,withdrawnAt:null,blockedAt:null}});
   if(daily>=this.config.int('DAILY_PUBLICATIONS',20)||active>=this.config.int('ACTIVE_PUBLICATIONS',1000))throw new ApiError(429,'RATE_LIMITED','Límite de publicaciones alcanzado.',86400);
   return tx.design.create({data:{ownerId,operationKey,title:dto.title.trim(),description:dto.description,category:dto.category.trim(),categoryKey:normalized(dto.category),tags:dto.tags,searchText:normalized(dto.title+' '+dto.description+' '+dto.tags.join(' ')),licenseVersion:LICENSE,sha256,svgKey:original.key,svgVersion:original.version,thumbnailKey:thumbnail.key,thumbnailVersion:thumbnail.version,thumbnail:prepared.thumbnail}});
  });
  return this.model(row);
 }
 async edit(ownerId:string,id:string,dto:EditDesignDto) {
  const row=await this.db.locked('design:'+id,async tx=>{
   const old=requireFound(await tx.design.findFirst({where:{id,ownerId}}));
   if(old.version!==dto.version)throw new ApiError(409,'VERSION_CONFLICT','Versión desactualizada.');
   return tx.design.update({where:{id},data:{title:dto.title.trim(),description:dto.description,category:dto.category.trim(),categoryKey:normalized(dto.category),tags:dto.tags,searchText:normalized(dto.title+' '+dto.description+' '+dto.tags.join(' ')),version:{increment:1}}});
  });
  return this.model(row);
 }
 async withdraw(ownerId:string,id:string,version:number) {
  await this.db.locked('design:'+id,async tx=>{
   const old=requireFound(await tx.design.findFirst({where:{id,ownerId}}));
   if(old.withdrawnAt)return;
   if(old.version!==version)throw new ApiError(409,'VERSION_CONFLICT','Versión desactualizada.');
   await tx.design.update({where:{id},data:{withdrawnAt:new Date(),version:{increment:1}}});
  });
 }
 async acquisitionContent(row:Acquisition) {
  const design=requireFound(await this.db.design.findUnique({where:{id:row.designId}}));
  if(design.blockedAt)throw new ApiError(403,'CONTENT_BLOCKED','Diseño bloqueado.');
  const bytes=await this.storage.read({key:design.svgKey,version:design.svgVersion},10000000);
  if(hash(bytes)!==design.sha256)throw new ApiError(503,'STORAGE_UNAVAILABLE','Integridad de contenido incorrecta.');
  return {id:row.id,designId:row.designId,title:row.title,svg:bytes.toString('utf8'),receipt:{payload:row.payload,signature:row.signature}};
 }
 async acquire(ownerId:string,dto:AcquireDto) {
  if(dto.licenseVersion!==LICENSE||!dto.accepted)throw new ApiError(422,'LICENSE_INVALID','Acepta licencia vigente.');
  const row=await this.db.locked('design:'+dto.designId,async tx=>{
   const design=requireFound(await tx.design.findUnique({where:{id:dto.designId}}));
   if(design.blockedAt)throw new ApiError(403,'CONTENT_BLOCKED','Diseño bloqueado.');
   const old=await tx.acquisition.findUnique({where:{ownerId_designId:{ownerId,designId:dto.designId}}});if(old)return old;
   if(design.withdrawnAt)throw new ApiError(404,'NOT_FOUND','Diseño retirado.');
   const id=randomUUID(),receipt=this.secrets.receipt({accountId:ownerId,designId:design.id,acquisitionId:id,sha256:design.sha256,licenseVersion:LICENSE});
   return tx.acquisition.create({data:{id,ownerId,designId:design.id,title:design.title,licenseVersion:LICENSE,licenseText:LICENSE_TEXT,...receipt}});
  });
  return this.acquisitionContent(row);
 }
 async acquisitions(ownerId:string,dto:PageDto) {
  const query=JSON.stringify(['acquisitions',ownerId]),rows=await this.db.acquisition.findMany({where:{ownerId,...this.secrets.uncursor(query,dto.cursor)},orderBy:[{createdAt:'desc'},{id:'desc'}],take:dto.limit+1});
  return this.secrets.page(rows,dto.limit,query,r=>({id:r.id,designId:r.designId,title:r.title}));
 }
 async content(ownerId:string,id:string) {return this.acquisitionContent(requireFound(await this.db.acquisition.findFirst({where:{id,ownerId}})));}
 async report(ownerId:string,dto:ReportDto,operationKey:string) {
  const existing=await this.db.report.findUnique({where:{operationKey}});if(existing)return;
  requireFound(await this.db.design.findUnique({where:{id:dto.designId}}));
  await this.db.report.upsert({where:{operationKey},create:{reporterId:ownerId,designId:dto.designId,operationKey,reason:dto.reason},update:{}});
 }
}
@Controller()
export class MarketController {
 constructor(private readonly market:Market,private readonly coordination:Coordination) {}
 @Get('designs') list(@Query() dto:PageDto){return this.market.list(dto);}
 @Get('designs/:id') detail(@Param('id',ParseUUIDPipe) id:string,@Req() req:ApiRequest){return this.market.detail(id,req.actor.id);}
 @Post('designs') async publish(@Req() req:ApiRequest,@Body() dto:PublishDto){await this.coordination.rate('svg:'+req.actor.id,30,60);return this.coordination.once(req.actor.id,'POST /designs',req.header('Idempotency-Key'),dto,key=>this.market.publish(req.actor.id,dto,key));}
 @Patch('designs/:id') edit(@Req() req:ApiRequest,@Param('id',ParseUUIDPipe) id:string,@Body() dto:EditDesignDto){return this.market.edit(req.actor.id,id,dto);}
 @Delete('designs/:id') @HttpCode(204) withdraw(@Req() req:ApiRequest,@Param('id',ParseUUIDPipe) id:string,@Body() dto:VersionDto){return this.market.withdraw(req.actor.id,id,dto.version);}
 @Post('acquisitions') acquire(@Req() req:ApiRequest,@Body() dto:AcquireDto){return this.coordination.once(req.actor.id,'POST /acquisitions',req.header('Idempotency-Key'),dto,()=>this.market.acquire(req.actor.id,dto));}
 @Get('acquisitions') acquisitions(@Req() req:ApiRequest,@Query() dto:PageDto){return this.market.acquisitions(req.actor.id,dto);}
 @Post('acquisitions/:id/content') @HttpCode(200) content(@Req() req:ApiRequest,@Param('id',ParseUUIDPipe) id:string){return this.market.content(req.actor.id,id);}
 @Post('reports') @HttpCode(204) report(@Req() req:ApiRequest,@Body() dto:ReportDto){return this.coordination.once(req.actor.id,'POST /reports',req.header('Idempotency-Key'),dto,key=>this.market.report(req.actor.id,dto,key));}
}
@Controller('admin')
export class AdminController {
 constructor(private readonly db:Db,private readonly secrets:Secrets) {}
 @Roles('moderator','admin') @Get('reports') async reports(@Query() dto:PageDto){
  const status=dto.status??'open',query=JSON.stringify(['reports',status]);
  const rows=await this.db.report.findMany({where:{resolvedAt:status==='open'?null:{not:null},...this.secrets.uncursor(query,dto.cursor)},orderBy:[{createdAt:'desc'},{id:'desc'}],take:dto.limit+1});
  return this.secrets.page(rows,dto.limit,query,r=>({id:r.id,reporterId:r.reporterId,designId:r.designId,reason:r.reason,resolution:r.resolution,createdAt:r.createdAt.toISOString(),resolvedAt:r.resolvedAt?.toISOString()??null}));
 }
 private async moderate(req:ApiRequest,id:string,reason:string,blocked:boolean) {
  await this.db.locked('design:'+id,async tx=>{
   requireFound(await tx.design.findUnique({where:{id}}));
   await tx.design.update({where:{id},data:{blockedAt:blocked?new Date():null,version:{increment:1}}});
   await tx.auditEvent.create({data:{actorId:req.actor.id,action:blocked?'design.block':'design.unblock',targetId:id,reason,requestId:req.requestId}});
  });
 }
 @Roles('moderator','admin') @Post('designs/:id/block') @HttpCode(204) block(@Req() req:ApiRequest,@Param('id',ParseUUIDPipe) id:string,@Body() dto:ReasonDto){return this.moderate(req,id,dto.reason,true);}
 @Roles('moderator','admin') @Post('designs/:id/unblock') @HttpCode(204) unblock(@Req() req:ApiRequest,@Param('id',ParseUUIDPipe) id:string,@Body() dto:ReasonDto){return this.moderate(req,id,dto.reason,false);}
 @Roles('moderator','admin') @Post('reports/:id/resolve') @HttpCode(204) async resolve(@Req() req:ApiRequest,@Param('id',ParseUUIDPipe) id:string,@Body() dto:ResolveDto){
  await this.db.$transaction(async tx=>{
   requireFound(await tx.report.findUnique({where:{id}}));
   await tx.report.update({where:{id},data:{resolution:dto.resolution,resolvedAt:new Date()}});
   await tx.auditEvent.create({data:{actorId:req.actor.id,action:'report.resolve',targetId:id,reason:dto.resolution,requestId:req.requestId}});
  });
 }
 @Roles('admin') @Post('users/:id/suspend') @HttpCode(204) async suspend(@Req() req:ApiRequest,@Param('id',ParseUUIDPipe) id:string,@Body() dto:ReasonDto){
  await this.db.locked('account:'+id,async tx=>{
   requireFound(await tx.user.findUnique({where:{id}}));
   await tx.user.update({where:{id},data:{suspendedAt:new Date()}});
   await tx.session.updateMany({where:{userId:id,revokedAt:null},data:{revokedAt:new Date()}});
   await tx.auditEvent.create({data:{actorId:req.actor.id,action:'user.suspend',targetId:id,reason:dto.reason,requestId:req.requestId}});
  });
 }
}
