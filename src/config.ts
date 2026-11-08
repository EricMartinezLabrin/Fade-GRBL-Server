import 'dotenv/config';
import { Injectable } from '@nestjs/common';
import { createPrivateKey, randomBytes } from 'node:crypto';
@Injectable()
export class Config {
 readonly env = process.env;
 get test() { return this.env.NODE_ENV === 'test'; }
 get databaseUrl() { return this.required('DATABASE_URL'); }
 get encryptionKey() {
  const key = Buffer.from(this.required('APP_ENCRYPTION_KEY'), 'base64');
  if (key.length !== 32 || key.equals(Buffer.alloc(32))) throw new Error('APP_ENCRYPTION_KEY must contain 32 random bytes (base64).');
  return key;
 }
 get privateKey() {
  const key = createPrivateKey(this.required('SIGNING_PRIVATE_KEY').replace(/\\n/g, '\n'));
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error('Signing key must be RSA >= 2048 bits.');
  return key;
 }
 required(name: string) {
  const value = this.env[name]?.trim();
  if (!value) throw new Error('Missing configuration: ' + name);
  return value;
 }
 int(name: string, fallback: number) {
  const value = Number(this.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid numeric configuration: ' + name);
  return value;
 }
 validate() {
  void this.databaseUrl; void this.encryptionKey; void this.privateKey;
  const origin = new URL(this.required('PUBLIC_ORIGIN'));
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username) throw new Error('PUBLIC_ORIGIN must be an HTTPS origin.');
  for (const name of ['AWS_ENDPOINT', 'AWS_REGION', 'AWS_BUCKET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'SMTP_HOST', 'SMTP_FROM']) this.required(name);
  if (new URL(this.required('AWS_ENDPOINT')).protocol !== 'https:' && !this.test) throw new Error('AWS_ENDPOINT requires HTTPS.');
 }
}
export const token = () => randomBytes(32).toString('base64url');
export const LICENSE = 'physical-products-v1';
export const LICENSE_TEXT = 'Permite uso personal y venta de productos físicos, solo dentro de FadeGRBL. Sin exportar ni redistribuir SVG o G-code.';
