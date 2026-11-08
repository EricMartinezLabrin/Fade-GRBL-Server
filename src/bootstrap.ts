import { ValidationPipe, RequestMethod } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { Config } from './config';
import { ApiError, ApiRequest } from './wire';
export function configure(app:NestExpressApplication) {
 const config=app.get(Config);config.validate();
 app.set('trust proxy',(config.env.TRUST_PROXY??'loopback').split(',').map(s=>s.trim()));
 app.disable('x-powered-by');
 app.setGlobalPrefix('api/v1',{exclude:[{path:'health',method:RequestMethod.GET}]});
 app.use((req:ApiRequest,res:express.Response,next:express.NextFunction)=>{
  req.requestId=randomUUID();res.setHeader('X-Request-Id',req.requestId);
  const start=Date.now();
  if(config.env.LOG_REQUESTS!=='false')res.on('finish',()=>process.stdout.write(JSON.stringify({requestId:req.requestId,method:req.method,path:req.path,status:res.statusCode,durationMs:Date.now()-start})+'\n'));
  if(req.path!=='/health'&&!req.secure){res.status(400).json({error:{code:'HTTPS_REQUIRED',message:'HTTPS obligatorio.',requestId:req.requestId}});return;}
  next();
 });
 app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'none'"]}}}));
 const large=express.json({limit:'32mb'}),small=express.json({limit:'64kb'});
 app.use((req:express.Request,res:express.Response,next:express.NextFunction)=>(req.method==='POST'&&req.path==='/api/v1/designs'?large:small)(req,res,next));
 app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true,exceptionFactory:errors=>{
  const oversized=errors.some(e=>(e.property==='sizeBytes'&&!!e.constraints?.max)||(e.property==='svg'&&!!e.constraints?.maxLength));
  return new ApiError(oversized?413:400,oversized?'FILE_TOO_LARGE':'VALIDATION_FAILED',oversized?'Archivo demasiado grande.':'Campos inválidos: '+errors.map(e=>e.property).join(', '));
 }}));
 app.enableShutdownHooks();
}
