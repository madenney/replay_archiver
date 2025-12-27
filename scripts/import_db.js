#!/usr/bin/env node
import 'dotenv/config';
import fs from 'fs';
import { spawn } from 'child_process';

const input = process.argv[2];

if (!input) {
  console.error('Usage: node scripts/import_db.js <input_file>');
  process.exit(1);
}

if (!fs.existsSync(input)) {
  console.error(`Input file not found: ${input}`);
  process.exit(1);
}

const env = { ...process.env };
env.PGHOST ||= 'localhost';
env.PGPORT ||= '5432';
env.PGUSER ||= 'postgres';
env.PGDATABASE ||= 'replay_archiver';
if (env.PGSSL === 'true' && !env.PGSSLMODE) env.PGSSLMODE = 'require';

const args = [
  '-d', env.PGDATABASE,
  '-h', env.PGHOST,
  '-p', env.PGPORT,
  '-U', env.PGUSER,
  input,
];

const proc = spawn('pg_restore', args, { env, stdio: 'inherit' });
proc.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
