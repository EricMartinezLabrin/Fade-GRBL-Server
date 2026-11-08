import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Config } from './config';
export type Tx = Prisma.TransactionClient;
@Injectable()
export class Db extends PrismaClient implements OnModuleDestroy {
 constructor(config: Config) { super({ adapter: new PrismaPg({ connectionString: config.databaseUrl }) }); }
 async onModuleDestroy() { await this.$disconnect(); }
 async locked<T>(key: string, work: (tx: Tx) => Promise<T>): Promise<T> {
 return this.$transaction(async tx => {
 await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
 return work(tx);
 }, { timeout: 15000, maxWait: 10000 });
 }
}
