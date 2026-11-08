require('dotenv').config({quiet:true});
const {PrismaClient}=require('@prisma/client'),{PrismaPg}=require('@prisma/adapter-pg');
const {hash,Algorithm}=require('@node-rs/argon2');
const crypto=require('node:crypto');
(async()=>{
 const email=process.argv[2]?.trim().toLowerCase(),password=process.env.ADMIN_PASSWORD;
 if(!email||!password||password.length<12||password.length>128)throw Error('Uso: ADMIN_PASSWORD=<secreto> pnpm admin:create correo');
 const db=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL})});
 try{
  const existing=await db.user.findUnique({where:{email}});
  if(existing)throw Error('Cuenta existente: promoción requiere operación administrativa explícita.');
  const id=crypto.randomUUID(),iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',Buffer.from(process.env.APP_ENCRYPTION_KEY,'base64'),iv);
  cipher.setAAD(Buffer.from('library:'+id));const encrypted=Buffer.concat([cipher.update(crypto.randomBytes(32).toString('base64'),'utf8'),cipher.final()]);
  await db.user.create({data:{id,email,displayName:'Administrador',emailVerified:true,role:'admin',passwordHash:await hash(password,{algorithm:Algorithm.Argon2id,memoryCost:65536,timeCost:3,parallelism:1}),encryptedLibraryKey:Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64')}});
  console.log('Administrador creado.');
 }finally{await db.$disconnect();}
})().catch(()=>{console.error('No se creó administrador. Revisa argumentos, configuración y existencia de cuenta.');process.exitCode=1;});
