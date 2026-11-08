import { Global, Module, Controller, Get } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Config } from './config';
import { Db } from './db';
import { Secrets } from './security';
import { Coordination } from './coordination';
import { Tasks } from './tasks';
import { ObjectStore, S3Store } from './storage';
import { SvgProcessor } from './svg';
import { Auth, AuthController, ProfilesController } from './auth';
import { Libraries, LibraryController } from './library';
import { Market, MarketController, AdminController } from './market';
import { Errors, AccessGuard, Public } from './wire';
@Global()
@Module({providers:[Config,Db,Secrets,Coordination,Tasks,SvgProcessor,{provide:ObjectStore,useClass:S3Store}],exports:[Config,Db,Secrets,Coordination,Tasks,SvgProcessor,ObjectStore]})
class InfrastructureModule {}
@Module({providers:[Auth],controllers:[AuthController,ProfilesController]})
class AccountsModule {}
@Module({providers:[Libraries],controllers:[LibraryController]})
class LibraryModule {}
@Module({providers:[Market],controllers:[MarketController,AdminController]})
class MarketplaceModule {}
@Controller()
class HealthController {
 constructor(private readonly db:Db){}
 @Public() @Get('health') async health(){await this.db.user.count();return {status:'ok'};}
}
@Module({imports:[InfrastructureModule,AccountsModule,LibraryModule,MarketplaceModule],controllers:[HealthController],providers:[{provide:APP_FILTER,useClass:Errors},{provide:APP_GUARD,useClass:AccessGuard}]})
export class AppModule {}
