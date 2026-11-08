# FadeGRBL Community Server

NestJS 11 + Express, Prisma 7 and PostgreSQL. Use pnpm exclusively.

## Commands

- `pnpm install --frozen-lockfile`
- `pnpm prisma:generate` / `pnpm prisma:validate`
- `pnpm build` / `pnpm lint` / `pnpm test`
- `pnpm test:integration` starts an isolated PostgreSQL instance, never the configured development database.
- `pnpm prisma:migrate` applies committed migrations only when explicitly requested. Never migrate on application startup.

## Structure and invariants

`src` contains feature modules and shared infrastructure; `prisma` owns database schema and migrations; `test` contains integration tests; `docs` contains API contract and requirement mapping.

Treat `docs/marketplace-server-contract.md` as the client compatibility contract. Preserve routes, camelCase shapes, codes, quota arithmetic and signing bytes. All database access goes through Prisma, including parameterized transactional locking queries. Never interpolate untrusted SQL.

Do not commit `.env`, credentials, private signing keys, tokens or live storage URLs. No production credentials in tests. Do not expose profile email or libraryKey. Logs must not include request bodies, authorization or signed URLs.

Use short transactions and account locks for quota, session rotation and idempotency. External I/O runs outside database locks. Cleanup and email must be durable and retryable. SVG validation precedes rendering in a bounded subprocess. Test concurrency on real isolated PostgreSQL.

Keep tests meaningful: security boundaries, rollback, retries and client wire compatibility. State clearly whether Backblaze, SMTP and production deployment were actually exercised. Never send real email or run live Backblaze tests without explicit opt-in.
