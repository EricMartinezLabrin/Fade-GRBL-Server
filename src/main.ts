import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { readFileSync } from 'node:fs';
import { AppModule } from './app.module';
import { Config } from './config';
import { configure } from './bootstrap';
async function bootstrap(){
 const config=new Config();config.validate();
 const key=config.env.HTTPS_KEY_FILE,cert=config.env.HTTPS_CERT_FILE;
 if(Boolean(key)!==Boolean(cert))throw new Error('Configure both HTTPS_KEY_FILE and HTTPS_CERT_FILE.');
 const app=await NestFactory.create<NestExpressApplication>(AppModule,{bodyParser:false,httpsOptions:key&&cert?{key:readFileSync(key),cert:readFileSync(cert)}:undefined});
 configure(app);await app.listen(config.int('PORT',3000),config.env.HOST??'127.0.0.1');
}
void bootstrap().catch(()=>{process.stderr.write('Server startup failed: verify configuration, database and TLS files.\n');process.exitCode=1;});
