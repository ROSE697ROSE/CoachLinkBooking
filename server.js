const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const app = express();
const port = process.env.PORT || 3000;
const databaseUrl = process.env.DATABASE_URL;
const SESSION_COOKIE = 'ena_session';
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.DATABASE_URL || 'temporary-development-secret-change-me';
app.use(express.json({ limit: '20kb' }));
let pool, initPromise;
function db() {
  if (!databaseUrl) throw new Error('Booking database is not connected yet.');
  if (!pool) pool = new Pool({ connectionString: databaseUrl, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  return pool;
}
async function initialise() {
  if (!initPromise) initPromise = (async () => {
    await db().query('CREATE TABLE IF NOT EXISTS accounts (id BIGSERIAL PRIMARY KEY, full_name VARCHAR(120) NOT NULL, phone VARCHAR(30) UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    await db().query('CREATE TABLE IF NOT EXISTS bookings (id BIGSERIAL PRIMARY KEY, reference VARCHAR(20) UNIQUE NOT NULL, departure VARCHAR(100) NOT NULL, destination VARCHAR(100) NOT NULL, travel_date DATE NOT NULL, passengers INTEGER NOT NULL CHECK (passengers BETWEEN 1 AND 5), passenger_name VARCHAR(120) NOT NULL, phone VARCHAR(30) NOT NULL, account_id BIGINT REFERENCES accounts(id), status VARCHAR(30) NOT NULL DEFAULT \'pending_payment\', trip_type VARCHAR(10) NOT NULL DEFAULT \'oneway\', return_date DATE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    await db().query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES accounts(id)');
    await db().query("ALTER TABLE bookings ALTER COLUMN status SET DEFAULT 'pending_payment'");
    await db().query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS trip_type VARCHAR(10) NOT NULL DEFAULT 'oneway'");
    await db().query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS return_date DATE');
  })();
  return initPromise;
}
function signToken(id) {
  const payload = Buffer.from(JSON.stringify({ id: String(id), exp: Date.now() + 604800000 })).toString('base64url');
  return payload + '.' + crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(parts[0]).digest();
  const actual = Buffer.from(parts[1], 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try { const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); return data.id && data.exp > Date.now() ? data : null; } catch { return null; }
}
function cookieValue(req) {
  const item = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(SESSION_COOKIE + '='));
  return item ? decodeURIComponent(item.slice(SESSION_COOKIE.length + 1)) : '';
}
function setSession(res, id) {
  res.setHeader('Set-Cookie', SESSION_COOKIE + '=' + encodeURIComponent(signToken(id)) + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800' + (process.env.NODE_ENV === 'production' ? '; Secure' : ''));
}
function clearSession(res) {
  res.setHeader('Set-Cookie', SESSION_COOKIE + '=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0' + (process.env.NODE_ENV === 'production' ? '; Secure' : ''));
}
async function requireAccount(req, res, next) {
  try {
    const token = verifyToken(cookieValue(req));
    if (!token) return res.status(401).json({ error: 'Please create an account or log in first.' });
    await initialise();
    const result = await db().query('SELECT id, full_name, phone FROM accounts WHERE id = $1', [token.id]);
    if (!result.rowCount) return res.status(401).json({ error: 'Please log in again.' });
    req.account = result.rows[0];
    next();
  } catch (e) { console.error('Account check failed:', e.message); res.status(503).json({ error: 'Account service is not ready. Please try again shortly.' }); }
}
app.get('/api/health', async (_req, res) => {
  try { await initialise(); await db().query('SELECT 1'); res.json({ ok: true, database: 'connected' }); }
  catch (e) { res.status(503).json({ ok: false, database: 'not_connected', error: e.message }); }
});
app.post('/api/auth/register', async (req, res) => {
  const { fullName, phone, password } = req.body || {};
  if (typeof fullName !== 'string' || fullName.trim().length < 2 || fullName.trim().length > 120 || typeof phone !== 'string' || !/^\+?[0-9\s-]{9,20}$/.test(phone.trim()) || typeof password !== 'string' || password.length < 8 || password.length > 128)
    return res.status(400).json({ error: 'Enter your full name, a valid phone number and a password of at least 8 characters.' });
  try {
    await initialise();
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await scrypt(password, salt, 64)).toString('hex');
    const result = await db().query('INSERT INTO accounts (full_name, phone, password_hash) VALUES ($1,$2,$3) RETURNING id, full_name, phone', [fullName.trim(), phone.trim(), salt + ':' + hash]);
    setSession(res, result.rows[0].id);
    res.status(201).json({ account: result.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'An account with this phone number already exists. Please log in.' });
    console.error('Registration failed:', e.message); res.status(503).json({ error: 'Account service is not ready. Please try again shortly.' });
  }
});
app.post('/api/auth/login', async (req, res) => {
  const { phone, password } = req.body || {};
  if (typeof phone !== 'string' || typeof password !== 'string' || !phone.trim() || !password) return res.status(400).json({ error: 'Enter your phone number and password.' });
  try {
    await initialise();
    const result = await db().query('SELECT id, full_name, phone, password_hash FROM accounts WHERE phone = $1', [phone.trim()]);
    if (!result.rowCount) return res.status(401).json({ error: 'Incorrect phone number or password.' });
    const account = result.rows[0], parts = account.password_hash.split(':');
    const candidate = await scrypt(password, parts[0], 64), stored = Buffer.from(parts[1], 'hex');
    if (stored.length !== candidate.length || !crypto.timingSafeEqual(candidate, stored)) return res.status(401).json({ error: 'Incorrect phone number or password.' });
    setSession(res, account.id);
    res.json({ account: { id: account.id, full_name: account.full_name, phone: account.phone } });
  } catch (e) { console.error('Login failed:', e.message); res.status(503).json({ error: 'Account service is not ready. Please try again shortly.' }); }
});
app.get('/api/auth/me', requireAccount, (req, res) => res.json({ account: req.account }));
app.post('/api/auth/logout', (_req, res) => { clearSession(res); res.json({ ok: true }); });
app.post('/api/bookings', requireAccount, async (req, res) => {
  const { from, to, travelDate, passengers, tripType = 'oneway', returnDate = null } = req.body || {};
  if (![from, to, travelDate].every(v => typeof v === 'string' && v.trim()) || !Number.isInteger(passengers) || passengers < 1 || passengers > 5 || !/^\d{4}-\d{2}-\d{2}$/.test(travelDate) || !['oneway','round'].includes(tripType) || (tripType === 'round' && (typeof returnDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(returnDate) || returnDate < travelDate)))
    return res.status(400).json({ error: 'Please complete all travel fields with valid details. A return date is required for round trips.' });
  if (new Date(travelDate + 'T00:00:00Z') < new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')) return res.status(400).json({ error: 'Travel date cannot be in the past.' });
  try {
    await initialise();
    const reference = 'ENA-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    await db().query('INSERT INTO bookings (reference, departure, destination, travel_date, passengers, passenger_name, phone, account_id, trip_type, return_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [reference, from.trim(), to.trim(), travelDate, passengers, req.account.full_name, req.account.phone, req.account.id, tripType, tripType === 'round' ? returnDate : null]);
    res.status(201).json({ reference, status: 'pending_payment' });
  } catch (e) { console.error('Booking save failed:', e.message); res.status(503).json({ error: 'Booking service is not ready. Please try again shortly.' }); }
});
app.use(express.static(path.join(__dirname, 'public')));
app.listen(port, () => console.log('ENA Coach booking server listening on ' + port));
