import { Injectable, Controller, Post, Body, Req, HttpCode, Get, Patch, Query, Param, ParseUUIDPipe } from '@nestjs/common';
import { Algorithm, hash as passwordHash, verify } from '@node-rs/argon2';
import { randomUUID, randomBytes } from 'node:crypto';
import { User } from '@prisma/client';
import { Db, Tx } from './db';
import { Config, token } from './config';
import { Secrets, hash, normalized } from './security';
import { Coordination } from './coordination';
import { Tasks } from './tasks';
import { ApiError, ApiRequest, Public, requireFound, privateUser, publicUser } from './wire';
import { RegisterDto, LoginDto, RefreshDto, ForgotDto, ResetDto, TokenDto, ProfileDto, PageDto } from './dto';
export const hashPassword=(value:string)=>passwordHash(value,{algorithm:Algorithm.Argon2id,memoryCost:65536,timeCost:3,parallelism:1,outputLen:32});
@Injectable()
export class Auth {
 private readonly dummy=hashPassword('constant invalid login password');
 constructor(private readonly db:Db,private readonly secrets:Secrets,private readonly coordination:Coordination,private readonly tasks:Tasks) {}
 private session(user:User,access:string,refresh:string,expiresAt:Date) {
  return {user:privateUser(user),accessToken:access,refreshToken:refresh,expiresAt:expiresAt.toISOString(),libraryKey:this.secrets.open(user.encryptedLibraryKey,'library:'+user.id)};
 }
 private async issue(tx:Tx,user:User,purpose:string) {
  const code=token();
  await tx.emailToken.updateMany({where:{userId:user.id,purpose,consumedAt:null},data:{consumedAt:new Date()}});
  await tx.emailToken.create({data:{userId:user.id,hash:hash(code),purpose,expiresAt:new Date(Date.now()+(purpose==='verify'?86400000:1800000))}});
  await this.tasks.enqueue(tx,'mail',{to:user.email,subject:purpose==='verify'?'Verifica tu cuenta FadeGRBL':'Recupera tu cuenta FadeGRBL',text:(purpose==='verify'?'Código para verificar correo: ':'Código para restablecer contraseña: ')+code+'\nSi no solicitaste este cambio, ignora mensaje.'});
 }
 async register(dto:RegisterDto,ip:string) {
  await this.coordination.rate('register:ip:'+ip,20,3600);
  const email=normalized(dto.email), encryptedPassword=await hashPassword(dto.password);
  await this.db.locked('email:'+email,async tx=>{
   if(await tx.user.findUnique({where:{email}})) return;
   const id=randomUUID();
   const user=await tx.user.create({data:{id,email,passwordHash:encryptedPassword,displayName:dto.displayName.trim(),encryptedLibraryKey:this.secrets.seal(randomBytes(32).toString('base64'),'library:'+id)}});
   await this.issue(tx,user,'verify');
  });
 }
 async login(dto:LoginDto,ip:string) {
  const email=normalized(dto.email);
  await this.coordination.rate('login:ip:'+ip,10,900);await this.coordination.rate('login:email:'+email,10,900);
  const user=await this.db.user.findUnique({where:{email}});
  const valid=await verify(user?.passwordHash??await this.dummy,dto.password).catch(()=>false);
  if(!user || !valid || user.suspendedAt) throw new ApiError(401,'AUTH_REQUIRED','Correo o contraseña inválidos.');
  return this.db.locked('account:'+user.id,async tx=>{
   const current=requireFound(await tx.user.findUnique({where:{id:user.id}}));
   if(current.suspendedAt || current.passwordHash!==user.passwordHash) throw new ApiError(401,'AUTH_REQUIRED','Correo o contraseña inválidos.');
   const access=token(), refresh=token(), accessExpiresAt=new Date(Date.now()+900000);
   await tx.session.create({data:{userId:user.id,accessHash:hash(access),refreshHash:hash(refresh),accessExpiresAt,refreshExpiresAt:new Date(Date.now()+2592000000)}});
   return this.session(current,access,refresh,accessExpiresAt);
  });
 }
 async refresh(refreshToken:string) {
  const digest=hash(refreshToken);
  const found=await this.db.session.findUnique({where:{refreshHash:digest}});
  const retired=found?null:await this.db.retiredRefresh.findUnique({where:{hash:digest}});
  if(!found && !retired) throw new ApiError(401,'SESSION_REVOKED','Sesión no válida.');
  const sessionId=found?.id??retired!.sessionId;
  const result=await this.db.locked('session:'+sessionId,async tx=>{
   const current=await tx.session.findUnique({where:{id:sessionId}});
   if(!current) return null;
   if(current.refreshHash!==digest) {await tx.session.update({where:{id:sessionId},data:{revokedAt:new Date()}});return null;}
   const user=await tx.user.findUnique({where:{id:current.userId}});
   if(current.revokedAt || current.refreshExpiresAt<=new Date() || !user || user.suspendedAt) return null;
   const access=token(), refresh=token(), accessExpiresAt=new Date(Date.now()+900000);
   await tx.retiredRefresh.create({data:{hash:digest,sessionId}});
   await tx.session.update({where:{id:sessionId},data:{accessHash:hash(access),refreshHash:hash(refresh),accessExpiresAt,refreshExpiresAt:new Date(Date.now()+2592000000)}});
   return this.session(user,access,refresh,accessExpiresAt);
  });
  if(!result) throw new ApiError(401,'SESSION_REVOKED','Sesión no válida.');
  return result;
 }
 async logout(refreshToken:string) {
  const digest=hash(refreshToken), current=await this.db.session.findUnique({where:{refreshHash:digest}}), old=current?null:await this.db.retiredRefresh.findUnique({where:{hash:digest}});
  const id=current?.id??old?.sessionId;
  if(id) await this.db.session.updateMany({where:{id,revokedAt:null},data:{revokedAt:new Date()}});
 }
 async emailRate(email:string,ip:string) {
  await this.coordination.rate('email:ip:'+ip,20,3600);await this.coordination.rate('email:account:'+email,3,3600);
 }
 async resend(user:User,ip:string) {
  await this.emailRate(user.email,ip);
  if(!user.emailVerified) await this.db.locked('account:'+user.id,tx=>this.issue(tx,user,'verify'));
 }
 async verify(user:User,code:string) {
  await this.db.locked('account:'+user.id,async tx=>{
   const entry=await tx.emailToken.findUnique({where:{hash:hash(code)}});
   if(!entry || entry.userId!==user.id || entry.purpose!=='verify' || entry.consumedAt || entry.expiresAt<=new Date()) throw new ApiError(400,'VALIDATION_FAILED','Código inválido o vencido.');
   await tx.emailToken.update({where:{id:entry.id},data:{consumedAt:new Date()}});
   await tx.user.update({where:{id:user.id},data:{emailVerified:true}});
  });
 }
 async forgot(email:string,ip:string) {
  email=normalized(email);await this.emailRate(email,ip);
  const user=await this.db.user.findUnique({where:{email}});
  if(user && !user.suspendedAt) await this.db.locked('account:'+user.id,tx=>this.issue(tx,user,'reset'));
 }
 async reset(dto:ResetDto) {
  const entry=await this.db.emailToken.findUnique({where:{hash:hash(dto.token)}});
  if(!entry || entry.purpose!=='reset') throw new ApiError(400,'VALIDATION_FAILED','Código inválido o vencido.');
  const encryptedPassword=await hashPassword(dto.password);
  await this.db.locked('account:'+entry.userId,async tx=>{
   const current=await tx.emailToken.findUnique({where:{id:entry.id}});
   if(!current || current.consumedAt || current.expiresAt<=new Date()) throw new ApiError(400,'VALIDATION_FAILED','Código inválido o vencido.');
   await tx.emailToken.update({where:{id:current.id},data:{consumedAt:new Date()}});
   await tx.user.update({where:{id:entry.userId},data:{passwordHash:encryptedPassword}});
   await tx.session.updateMany({where:{userId:entry.userId,revokedAt:null},data:{revokedAt:new Date()}});
  });
 }
}
@Controller('auth')
export class AuthController {
 constructor(private readonly auth:Auth,private readonly coordination:Coordination) {}
 @Public() @Post('register') @HttpCode(204) register(@Body() dto:RegisterDto,@Req() req:ApiRequest){return this.auth.register(dto,req.ip??'');}
 @Public() @Post('login') @HttpCode(200) login(@Body() dto:LoginDto,@Req() req:ApiRequest){return this.auth.login(dto,req.ip??'');}
 @Public() @Post('refresh') @HttpCode(200) async refresh(@Body() dto:RefreshDto,@Req() req:ApiRequest){await this.coordination.rate('refresh:'+req.ip,60,60);return this.auth.refresh(dto.refreshToken);}
 @Public() @Post('logout') @HttpCode(204) logout(@Body() dto:RefreshDto){return this.auth.logout(dto.refreshToken);}
 @Post('email/verify') @HttpCode(204) async verify(@Body() dto:TokenDto,@Req() req:ApiRequest){await this.coordination.rate('verify:'+req.actor.id,10,900);return this.auth.verify(req.actor,dto.token);}
 @Post('email/resend') @HttpCode(204) resend(@Req() req:ApiRequest){return this.auth.resend(req.actor,req.ip??'');}
 @Public() @Post('password/forgot') @HttpCode(204) forgot(@Body() dto:ForgotDto,@Req() req:ApiRequest){return this.auth.forgot(dto.email,req.ip??'');}
 @Public() @Post('password/reset') @HttpCode(204) async reset(@Body() dto:ResetDto,@Req() req:ApiRequest){await this.coordination.rate('reset:'+req.ip,10,900);return this.auth.reset(dto);}
}
@Controller()
export class ProfilesController {
 constructor(private readonly db:Db,private readonly secrets:Secrets) {}
 @Get('me') me(@Req() req:ApiRequest){return privateUser(req.actor);}
 @Patch('me') async patch(@Req() req:ApiRequest,@Body() dto:ProfileDto){return privateUser(await this.db.user.update({where:{id:req.actor.id},data:{displayName:dto.displayName?.trim(),bio:dto.bio}}));}
 @Get('me/quota') quota(@Req() req:ApiRequest){return {limitBytes:req.actor.quotaBytes,usedBytes:req.actor.usedBytes,reservedBytes:req.actor.reservedBytes};}
 @Get('designers') async designers(@Query() dto:PageDto){
  const query=JSON.stringify(['designers',normalized(dto.q??'')]), cursor=this.secrets.uncursor(query,dto.cursor);
  const rows=await this.db.user.findMany({where:{suspendedAt:null,...cursor,OR:dto.q?[{displayName:{contains:dto.q,mode:'insensitive'}},{bio:{contains:dto.q,mode:'insensitive'}}]:undefined,AND:cursor?[cursor]:undefined},orderBy:[{createdAt:'desc'},{id:'desc'}],take:dto.limit+1});
  return this.secrets.page(rows,dto.limit,query,publicUser);
 }
 @Get('designers/:id') async designer(@Param('id',ParseUUIDPipe) id:string){return publicUser(requireFound(await this.db.user.findFirst({where:{id,suspendedAt:null}})));}
}
