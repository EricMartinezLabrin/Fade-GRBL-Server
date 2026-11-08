import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Injectable, CanActivate, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { User } from '@prisma/client';
import { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { Db } from './db';
export class ApiError extends Error {
 constructor(public status: number, public code: string, message: string, public retryAfter?: number) { super(message); }
}
export const Public = () => SetMetadata('public', true);
export const Roles = (...roles: string[]) => SetMetadata('roles', roles);
export type ApiRequest = Request & { actor: User; sessionId: string; requestId: string };
@Catch()
export class Errors implements ExceptionFilter {
 catch(error: unknown, host: ArgumentsHost) {
  const req = host.switchToHttp().getRequest<ApiRequest>();
  const res = host.switchToHttp().getResponse<Response>();
  let status = 500, code = 'INTERNAL_ERROR', message = 'No se pudo completar operación.';
  if (error instanceof ApiError) { status = error.status; code = error.code; message = error.message; if (error.retryAfter) res.setHeader('Retry-After', error.retryAfter); }
  else if (error instanceof HttpException) { status = error.getStatus(); code = status === 404 ? 'NOT_FOUND' : 'VALIDATION_FAILED'; message = status === 404 ? 'Recurso no encontrado.' : 'Solicitud inválida.'; }
  else if (typeof error === 'object' && error) {
   const e = error as {code?: string; type?: string; status?: number};
   if (e.type === 'entity.too.large') { status = 413; code = 'FILE_TOO_LARGE'; message = 'Solicitud demasiado grande.'; }
   else if (e.code === 'P2002') { status = 409; code = 'VERSION_CONFLICT'; message = 'Recurso duplicado.'; }
   else if (e.code === 'P2025') { status = 404; code = 'NOT_FOUND'; message = 'Recurso no encontrado.'; }
   else if (e.code?.startsWith('P1') || e.code === 'ECONNREFUSED') { status = 503; code = 'STORAGE_UNAVAILABLE'; message = 'Servicio temporalmente indisponible.'; }
   else if (e.status === 400) { status = 400; code = 'VALIDATION_FAILED'; message = 'JSON inválido.'; }
  }
  res.status(status).json({error:{code,message,requestId:req.requestId}});
 }
}
@Injectable()
export class AccessGuard implements CanActivate {
 constructor(private readonly db: Db, private readonly reflector: Reflector) {}
 async canActivate(context: ExecutionContext) {
  if (this.reflector.getAllAndOverride<boolean>('public', [context.getHandler(), context.getClass()])) return true;
  const req = context.switchToHttp().getRequest<ApiRequest>();
  const bearer = req.headers.authorization;
  if (!bearer?.startsWith('Bearer ') || bearer.length > 512) throw new ApiError(401,'AUTH_REQUIRED','Inicia sesión.');
  const accessHash = createHash('sha256').update(bearer.slice(7)).digest('hex');
  const session = await this.db.session.findUnique({where:{accessHash}});
  if (!session || session.revokedAt) throw new ApiError(401,'SESSION_REVOKED','Sesión revocada.');
  if (session.accessExpiresAt <= new Date()) throw new ApiError(401,'TOKEN_EXPIRED','Sesión vencida.');
  const user = await this.db.user.findUnique({where:{id:session.userId}});
  if (!user || user.suspendedAt) throw new ApiError(401,'SESSION_REVOKED','Sesión revocada.');
  req.actor=user; req.sessionId=session.id;
  const roles = this.reflector.getAllAndOverride<string[]>('roles',[context.getHandler(),context.getClass()]);
  if (roles && !roles.includes(user.role)) throw new ApiError(403,'FORBIDDEN','Permiso insuficiente.');
  return true;
 }
}
export const requireFound = <T>(value: T | null): T => { if (value == null) throw new ApiError(404,'NOT_FOUND','Recurso no encontrado.'); return value; };
export const publicUser = (user: User) => ({id:user.id,displayName:user.displayName,bio:user.bio,avatarUrl:null});
export const privateUser = (user: User) => ({...publicUser(user),email:user.email,emailVerified:user.emailVerified});
