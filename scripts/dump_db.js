#!/usr/bin/env node
import 'dotenv/config';
import { spawn } from 'child_process';

const output = process.argv[2];

if (!output) {
  console.error('Usage: node scripts/dump_db.js <output_file>');
  process.exit(1);
}

const env = { ...process.env };
env.PGHOST ||= 'localhost';
env.PGPORT ||= '5432';
env.PGUSER ||= 'postgres';
env.PGDATABASE ||= 'replay_archiver';
if (env.PGSSL === 'true' && !env.PGSSLMODE) env.PGSSLMODE = 'require';

const args = [
  '-Fc',
  '-f', output,
  '-h', env.PGHOST,
  '-p', env.PGPORT,
  '-U', env.PGUSER,
  env.PGDATABASE,
];

const proc = spawn('pg_dump', args, { env, stdio: 'inherit' });
proc.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
