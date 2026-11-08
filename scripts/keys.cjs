const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const envPath=path.resolve('.env');
let content=fs.existsSync(envPath)?fs.readFileSync(envPath,'utf8'):'';
if(!/^APP_ENCRYPTION_KEY=.+$/m.test(content)){
 const pair=crypto.generateKeyPairSync('rsa',{modulusLength:3072,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
 content+='\nAPP_ENCRYPTION_KEY='+crypto.randomBytes(32).toString('base64')+'\nSIGNING_PRIVATE_KEY="'+pair.privateKey.replace(/\n/g,'\\n')+'"\n';
 fs.writeFileSync(envPath,content,{mode:0o600});
}
require('dotenv').config({quiet:true});
const key=crypto.createPublicKey(process.env.SIGNING_PRIVATE_KEY.replace(/\\n/g,'\n')).export({format:'jwk'});
const b64=s=>Buffer.from(s,'base64url').toString('base64');
const publicXml='<RSAKeyValue><Modulus>'+b64(key.n)+'</Modulus><Exponent>'+b64(key.e)+'</Exponent></RSAKeyValue>';
fs.mkdirSync('config',{recursive:true});fs.writeFileSync('config/signing-public.xml',publicXml+'\n');
console.log('Claves privadas conservadas en .env; clave pública: config/signing-public.xml');
