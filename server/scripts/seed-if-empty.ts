// Seeds the demo data only when the database has no tenant yet (first deploy). Never wipes existing data.
import { execSync } from 'node:child_process';
import { db } from '../src/db.js';

const n = await db.tenant.count();
await db.$disconnect();
if (n === 0) { console.log('Empty database: seeding demo data'); execSync('npx tsx src/seed.ts', { stdio: 'inherit' }); }
else console.log(`Database already has ${n} tenant(s): not seeding`);
