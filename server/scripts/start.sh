#!/bin/sh
# Production start: make sure pgvector and the schema exist, seed demo data on an empty database, then run the API.
set -e
echo 'CREATE EXTENSION IF NOT EXISTS vector;' | npx prisma db execute --stdin --schema prisma/schema.prisma
npx prisma db push --skip-generate
if [ "${SEED_IF_EMPTY:-true}" = "true" ]; then npx tsx scripts/seed-if-empty.ts; fi
exec npx tsx src/index.ts
