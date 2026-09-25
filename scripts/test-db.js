// Database connection check. Usage:
//   node scripts/test-db.js                    (uses DATABASE_URL from .env)
//   node scripts/test-db.js "postgresql://..."   (test another URL)
// Prints user, host and the exact failure reason. Never prints the password.
import 'dotenv/config';
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import pg from 'pg';

const url = process.argv[2] || process.env.DATABASE_URL;
if (!url) { console.log('DATABASE_URL is empty in .env'); process.exit(1); }
let u;
try { u = new URL(url); } catch {
  console.log('DATABASE_URL is not a valid URL. If the password has @ : / # ? characters, reset it to letters and numbers only.');
  process.exit(1);
}
const port = Number(u.port || 5432);
console.log(`user: ${decodeURIComponent(u.username)}   host: ${u.hostname}   port: ${port}   database: ${u.pathname.slice(1)}`);
if (!u.password) console.log('WARNING: no password in the URL');
if (u.password.includes('[') || u.password.includes('YOUR-PASSWORD')) console.log('WARNING: the password still looks like the placeholder');

let reachedServer = false;
let loginError = '';
async function checkHost(host) {
  try {
    const ips = await dns.lookup(host, { all: true });
    console.log(`  1. DNS ok: ${ips.map((i) => i.address).join(', ')}`);
  } catch (e) {
    console.log(`  1. DNS FAILED: ${e.code} (host name does not exist)`);
    return false;
  }
  // 2. TCP + TLS: send Postgres SSLRequest, expect "S", then complete a TLS handshake.
  const tlsResult = await new Promise((resolve) => {
    const s = net.connect({ host, port });
    const timer = setTimeout(() => { s.destroy(); resolve({ ok: false, msg: 'no answer within 8 s' }); }, 8000);
    s.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, msg: `TCP error ${e.code}` }); });
    s.on('connect', () => {
      const b = Buffer.alloc(8);
      b.writeInt32BE(8, 0);
      b.writeInt32BE(80877103, 4); // SSLRequest code
      s.write(b);
    });
    s.once('data', (d) => {
      const ch = String.fromCharCode(d[0]);
      if (ch !== 'S') { clearTimeout(timer); s.destroy(); return resolve({ ok: false, msg: `server does not offer TLS (answered "${ch}")` }); }
      const t0 = Date.now();
      const t = tls.connect({ socket: s, servername: host, rejectUnauthorized: false }, () => {
        clearTimeout(timer);
        const issuer = t.getPeerCertificate()?.issuer?.O || t.getPeerCertificate()?.issuer?.CN || 'unknown';
        resolve({ ok: true, msg: `ok in ${Date.now() - t0} ms, certificate issued by "${issuer}"` });
        t.destroy();
      });
      t.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, msg: `TLS error ${e.code || e.message}` }); });
    });
  });
  console.log(`  2. TCP + TLS: ${tlsResult.ok ? tlsResult.msg : 'FAILED - ' + tlsResult.msg}`);
  if (!tlsResult.ok) return false;
  reachedServer = true;

  const started = Date.now();
  const test = new URL(url);
  test.hostname = host;
  const c = new pg.Client({ connectionString: test.toString(), ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  try {
    await c.connect();
    const r = await c.query(`select current_user as usr, to_regclass('app.networks') is not null as has_schema`);
    console.log(`  3. Login ok in ${Date.now() - started} ms as "${r.rows[0].usr}". Schema installed: ${r.rows[0].has_schema}`);
    return true;
  } catch (e) {
    console.log(`  3. Login FAILED after ${Date.now() - started} ms: ${e.code || ''} ${e.message}`);
    if (e.code === '28P01') loginError = 'password';
    return false;
  } finally {
    await c.end().catch(() => {});
  }
}

console.log(`\nTesting ${u.hostname}`);
const ok = await checkHost(u.hostname);
if (ok) process.exit(0);

// Supabase runs several pooler clusters per region (aws-0-…, aws-1-…). A project only answers on its own one.
const m = u.hostname.match(/^aws-(\d+)-(.+\.pooler\.supabase\.com)$/);
if (m) {
  for (const n of [0, 1, 2].filter((x) => String(x) !== m[1])) {
    const alt = `aws-${n}-${m[2]}`;
    console.log(`\nTesting ${alt} (other Supabase pooler cluster)`);
    if (await checkHost(alt)) {
      console.log(`\nFIX: in .env change the host in DATABASE_URL to ${alt}`);
      process.exit(0);
    }
  }
}
if (loginError === 'password') {
  console.log(`\nRESULT: the network is fine and ${u.hostname} is the right host. The PASSWORD in DATABASE_URL is wrong.`);
  process.exit(1);
}
if (reachedServer) {
  console.log('\nRESULT: the network is fine. Check the user (stable_api.<project-ref>) and password in DATABASE_URL.');
  process.exit(1);
}
// Network problem: is port 5432 specifically blocked? Supabase also listens on 6543 (transaction pooler).
async function probe(host, p) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port: p });
    const timer = setTimeout(() => { s.destroy(); resolve(false); }, 8000);
    s.on('error', () => { clearTimeout(timer); resolve(false); });
    s.on('connect', () => { const b = Buffer.alloc(8); b.writeInt32BE(8, 0); b.writeInt32BE(80877103, 4); s.write(b); });
    s.once('data', (d) => { clearTimeout(timer); s.destroy(); resolve(String.fromCharCode(d[0]) === 'S'); });
  });
}
const answers6543 = await probe(u.hostname, 6543);
console.log(`\nPort 6543 on ${u.hostname}: ${answers6543 ? 'ANSWERS' : 'no answer'}`);
console.log(answers6543
  ? 'RESULT: your network or security software blocks Postgres traffic on port 5432 (6543 works). Railway is not affected.'
  : 'RESULT: Postgres traffic is blocked from this PC/network (VPN, proxy, antivirus firewall or provider). Railway is not affected.');
