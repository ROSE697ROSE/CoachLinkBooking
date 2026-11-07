const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');
const routeData = require('./route-fares.json');
const QRCode = require('qrcode');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const app = express();
const port = process.env.PORT || 3000;
const databaseUrl = process.env.DATABASE_URL;
const SESSION_COOKIE = 'coachlink_session';
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.DATABASE_URL || 'temporary-development-secret-change-me';
app.use(express.json({ limit: '30kb' }));
let pool, initPromise;

function db() {
  if (!databaseUrl) throw new Error('Booking database is not connected yet.');
  if (!pool) pool = new Pool({ connectionString: databaseUrl, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  return pool;
}
async function initialise() {
  if (!initPromise) initPromise = (async () => {
    await db().query('CREATE TABLE IF NOT EXISTS accounts (id BIGSERIAL PRIMARY KEY, full_name VARCHAR(120) NOT NULL, phone VARCHAR(30) UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    await db().query("CREATE TABLE IF NOT EXISTS bookings (id BIGSERIAL PRIMARY KEY, reference VARCHAR(24) UNIQUE NOT NULL, departure VARCHAR(100) NOT NULL, destination VARCHAR(100) NOT NULL, travel_date DATE NOT NULL, passengers INTEGER NOT NULL CHECK (passengers BETWEEN 1 AND 5), passenger_name VARCHAR(120) NOT NULL, phone VARCHAR(30) NOT NULL, account_id BIGINT REFERENCES accounts(id), status VARCHAR(30) NOT NULL DEFAULT 'pending_payment', trip_type VARCHAR(10) NOT NULL DEFAULT 'oneway', return_date DATE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    const migrations = [
      "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS fare_per_passenger INTEGER",
      "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS amount_kes INTEGER",
      "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) NOT NULL DEFAULT 'not_started'",
      "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_phone VARCHAR(20)",
      "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checkout_request_id VARCHAR(100)",
      "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS merchant_request_id VARCHAR(100)",
      "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS mpesa_receipt_number VARCHAR(30)",
      "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_result TEXT",
      "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ",
      "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS trip_type VARCHAR(10) NOT NULL DEFAULT 'oneway'",
      "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS return_date DATE",
      "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES accounts(id)"
    ];
    for (const sql of migrations) await db().query(sql);
    await db().query("CREATE UNIQUE INDEX IF NOT EXISTS bookings_checkout_request_unique ON bookings(checkout_request_id) WHERE checkout_request_id IS NOT NULL");
  })().catch(error => {
    initPromise = null;
    throw error;
  });
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
function normalisePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (/^0[17]\d{8}$/.test(digits)) return '254' + digits.slice(1);
  if (/^[17]\d{8}$/.test(digits)) return '254' + digits;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  return null;
}
function getFare(from, to) {
  const a = from.trim().toLowerCase(), b = to.trim().toLowerCase();
  const match = routeData.routes.find(r =>
    (r.from.toLowerCase() === a && r.to.toLowerCase() === b) ||
    (r.from.toLowerCase() === b && r.to.toLowerCase() === a)
  );
  return match && Number.isInteger(match.fare) && match.fare > 0 ? match.fare : null;
}
function mpesaConfig() {
  const env = (process.env.MPESA_ENV || 'sandbox').toLowerCase();
  if (!['sandbox', 'production'].includes(env)) throw new Error('MPESA_ENV must be sandbox or production.');
  const required = ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY', 'MPESA_CALLBACK_URL'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) throw new Error('M-Pesa is not configured. Add the Daraja settings in Render Environment.');
  const callback = process.env.MPESA_CALLBACK_URL;
  if (!callback.startsWith('https://')) throw new Error('MPESA_CALLBACK_URL must be a public HTTPS URL.');
  return {
    base: env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke',
    shortcode: process.env.MPESA_SHORTCODE,
    passkey: process.env.MPESA_PASSKEY,
    key: process.env.MPESA_CONSUMER_KEY,
    secret: process.env.MPESA_CONSUMER_SECRET,
    callback,
    transactionType: process.env.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline',
    env
  };
}
async function mpesaToken(config) {
  const auth = Buffer.from(config.key + ':' + config.secret).toString('base64');
  const response = await fetch(config.base + '/oauth/v1/generate?grant_type=client_credentials', { headers: { Authorization: 'Basic ' + auth } });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(data.errorMessage || 'Could not authenticate with Safaricom Daraja.');
  return data.access_token;
}
function mpesaTimestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}
function callbackItems(items) {
  const out = {};
  for (const item of items || []) if (item && item.Name) out[item.Name] = item.Value;
  return out;
}

app.get('/api/routes', (_req, res) => {
  const unique = new Map();
  for (const route of routeData.routes) {
    const key = route.from.toLowerCase() + '|' + route.to.toLowerCase();
    if (!unique.has(key)) unique.set(key, { from: route.from, to: route.to, fare: route.fare, corridor: route.routeLabel });
    const reverseKey = route.to.toLowerCase() + '|' + route.from.toLowerCase();
    if (!unique.has(reverseKey)) unique.set(reverseKey, { from: route.to, to: route.from, fare: route.fare, corridor: route.routeLabel });
  }
  res.json({ source: routeData.source, lastVerified: routeData.lastVerified, currency: routeData.currency, routes: [...unique.values()] });
});

app.get('/api/health', async (_req, res) => {
  try { await initialise(); await db().query('SELECT 1'); res.json({ ok: true, database: 'connected', payments: 'Daraja configured only when Render environment variables are set' }); }
  catch (e) { res.status(503).json({ ok: false, database: 'not_connected', error: e.message }); }
});
app.post('/api/auth/register', async (req, res) => {
  const { fullName, phone, password } = req.body || {};
  if (typeof fullName !== 'string' || fullName.trim().length < 2 || fullName.trim().length > 120 || typeof phone !== 'string' || !/^\\+?[0-9\\s-]{9,20}$/.test(phone.trim()) || typeof password !== 'string' || password.length < 8 || password.length > 128)
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
  if (![from, to, travelDate].every(v => typeof v === 'string' && v.trim()) || from.trim().toLowerCase() === to.trim().toLowerCase() || !Number.isInteger(passengers) || passengers < 1 || passengers > 5 || !/^\d{4}-\d{2}-\d{2}$/.test(travelDate) || !['oneway','round'].includes(tripType) || (tripType === 'round' && (typeof returnDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(returnDate) || returnDate < travelDate)))
    return res.status(400).json({ error: 'Please complete all travel fields with valid details. A valid return date is required for round trips.' });
  if (new Date(travelDate + 'T00:00:00Z') < new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')) return res.status(400).json({ error: 'Travel date cannot be in the past.' });
  const fare = getFare(from, to);
  if (!fare) return res.status(400).json({ error: 'This route has no verified fare configured yet. Please contact the operator. No payment has been requested.' });
  const amount = fare * passengers * (tripType === 'round' ? 2 : 1);
  if (!Number.isSafeInteger(amount) || amount < 1) return res.status(400).json({ error: 'Invalid booking amount.' });
  try {
    await initialise();
    const reference = 'CLB-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    await db().query('INSERT INTO bookings (reference, departure, destination, travel_date, passengers, passenger_name, phone, account_id, trip_type, return_date, fare_per_passenger, amount_kes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [reference, from.trim(), to.trim(), travelDate, passengers, req.account.full_name, req.account.phone, req.account.id, tripType, tripType === 'round' ? returnDate : null, fare, amount]);
    res.status(201).json({ reference, status: 'pending_payment', amountKes: amount, currency: 'KES', phone: req.account.phone });
  } catch (e) { console.error('Booking save failed:', e.message); res.status(503).json({ error: 'Booking service is not ready. Please try again shortly.' }); }
});

app.post('/api/payments/stk-push', requireAccount, async (req, res) => {
  const { reference, phone: suppliedPhone } = req.body || {};
  const phone = normalisePhone(suppliedPhone || req.account.phone);
  if (!reference || typeof reference !== 'string') return res.status(400).json({ error: 'Booking reference is required.' });
  if (!phone) return res.status(400).json({ error: 'Enter a valid Kenyan M-Pesa number, for example 0712345678.' });
  let config;
  try { config = mpesaConfig(); }
  catch (e) { return res.status(503).json({ error: e.message, code: 'MPESA_NOT_CONFIGURED' }); }
  try {
    await initialise();
    const found = await db().query("SELECT id, reference, amount_kes, payment_status FROM bookings WHERE reference=$1 AND account_id=$2", [reference, req.account.id]);
    if (!found.rowCount) return res.status(404).json({ error: 'Booking not found.' });
    const booking = found.rows[0];
    if (!booking.amount_kes) return res.status(400).json({ error: 'Booking amount is missing. Contact support.' });
    if (booking.payment_status === 'paid') return res.status(409).json({ error: 'This booking is already paid.' });
    if (booking.payment_status === 'processing') return res.status(409).json({ error: 'A payment request is already processing. Check payment status before trying again.' });
    const token = await mpesaToken(config);
    const timestamp = mpesaTimestamp();
    const password = Buffer.from(config.shortcode + config.passkey + timestamp).toString('base64');
    const payload = {
      BusinessShortCode: config.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: config.transactionType,
      Amount: Number(booking.amount_kes),
      PartyA: phone,
      PartyB: config.shortcode,
      PhoneNumber: phone,
      CallBackURL: config.callback,
      AccountReference: booking.reference,
      TransactionDesc: 'CoachLink bus ticket'
    };
    const response = await fetch(config.base + '/mpesa/stkpush/v1/processrequest', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok || data.ResponseCode !== '0' || !data.CheckoutRequestID) {
      console.error('Daraja STK request rejected:', JSON.stringify(data));
      return res.status(502).json({ error: data.errorMessage || data.ResponseDescription || 'Safaricom did not accept the payment request.' });
    }
    await db().query("UPDATE bookings SET payment_status='processing', payment_phone=$1, checkout_request_id=$2, merchant_request_id=$3, payment_result=NULL WHERE id=$4", [phone, data.CheckoutRequestID, data.MerchantRequestID || null, booking.id]);
    res.status(202).json({ status: 'processing', reference: booking.reference, checkoutRequestId: data.CheckoutRequestID, customerMessage: data.CustomerMessage || 'Check your phone and enter your M-Pesa PIN to pay.' });
  } catch (e) {
    console.error('STK push failed:', e.message);
    res.status(502).json({ error: 'Could not start M-Pesa payment. Please try again or contact support.' });
  }
});

app.post('/api/payments/callback', async (req, res) => {
  try {
    const body = req.body || {};
    const callback = body.Body && body.Body.stkCallback;
    if (!callback || !callback.CheckoutRequestID) return res.status(400).json({ Result: 'Invalid callback payload' });
    await initialise();
    const resultCode = Number(callback.ResultCode);
    const description = String(callback.ResultDesc || '').slice(0, 500);
    if (resultCode !== 0) {
      await db().query("UPDATE bookings SET payment_status='failed', payment_result=$1 WHERE checkout_request_id=$2 AND payment_status <> 'paid'", [description, callback.CheckoutRequestID]);
      return res.json({ Result: 'Accepted' });
    }
    const meta = callbackItems(callback.CallbackMetadata && callback.CallbackMetadata.Item);
    const amount = Number(meta.Amount);
    const receipt = String(meta.MpesaReceiptNumber || '');
    const phone = String(meta.PhoneNumber || '');
    const transactionDate = meta.TransactionDate ? String(meta.TransactionDate) : null;
    if (!Number.isFinite(amount) || !receipt) {
      await db().query("UPDATE bookings SET payment_status='review', payment_result=$1 WHERE checkout_request_id=$2 AND payment_status <> 'paid'", ['Successful callback missing amount or receipt number', callback.CheckoutRequestID]);
      return res.json({ Result: 'Accepted' });
    }
    const updated = await db().query(
      "UPDATE bookings SET payment_status='paid', status='paid', mpesa_receipt_number=$1, payment_result=$2, paid_at=NOW() WHERE checkout_request_id=$3 AND amount_kes=$4 AND payment_status <> 'paid' RETURNING reference",
      [receipt, 'Safaricom confirmed payment; phone=' + phone + '; transactionDate=' + (transactionDate || ''), callback.CheckoutRequestID, amount]
    );
    if (!updated.rowCount) {
      await db().query("UPDATE bookings SET payment_status='review', payment_result=$1 WHERE checkout_request_id=$2 AND payment_status <> 'paid'", ['Payment callback amount did not match booking or booking was not found', callback.CheckoutRequestID]);
      console.warn('M-Pesa callback requires review for checkout request:', callback.CheckoutRequestID);
    }
    return res.json({ Result: 'Accepted' });
  } catch (e) {
    console.error('M-Pesa callback processing failed:', e.message);
    return res.status(500).json({ Result: 'Callback processing failed' });
  }
});

app.get('/api/payments/status/:reference', requireAccount, async (req, res) => {
  try {
    await initialise();
    const result = await db().query('SELECT reference, amount_kes, payment_status, mpesa_receipt_number, payment_result, paid_at FROM bookings WHERE reference=$1 AND account_id=$2', [req.params.reference, req.account.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Booking not found.' });
    const b = result.rows[0];
    res.json({ reference: b.reference, amountKes: b.amount_kes, status: b.payment_status, receipt: b.mpesa_receipt_number, paidAt: b.paid_at, message: b.payment_status === 'paid' ? 'Payment confirmed. Your booking is paid.' : b.payment_status === 'processing' ? 'Waiting for Safaricom payment confirmation.' : b.payment_status === 'failed' ? 'Payment was not completed. You may try again.' : b.payment_status === 'review' ? 'Payment is being checked by support.' : 'Payment has not started.' });
  } catch (e) { console.error('Payment status failed:', e.message); res.status(503).json({ error: 'Could not check payment status.' }); }
});

app.get('/api/tickets/:reference', requireAccount, async (req, res) => {
  try {
    await initialise();
    const result = await db().query(
      "SELECT reference, departure, destination, travel_date, passengers, passenger_name, phone, trip_type, return_date, amount_kes, mpesa_receipt_number, paid_at FROM bookings WHERE reference=$1 AND account_id=$2 AND payment_status='paid'",
      [req.params.reference, req.account.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Paid ticket not found. Complete payment first.' });
    const ticket = result.rows[0];
    const issued = ticket.paid_at ? new Date(ticket.paid_at).toISOString() : new Date().toISOString();
    const signedPayload = ['COACHLINK', ticket.reference, issued].join('|');
    const signature = crypto.createHmac('sha256', SESSION_SECRET).update(signedPayload).digest('hex');
    const qrDataUrl = await QRCode.toDataURL(signedPayload + '|' + signature, { errorCorrectionLevel: 'M', margin: 2, width: 260 });
    res.json({
      reference: ticket.reference,
      passenger: ticket.passenger_name,
      phone: ticket.phone,
      from: ticket.departure,
      to: ticket.destination,
      travelDate: ticket.travel_date,
      passengers: ticket.passengers,
      tripType: ticket.trip_type,
      returnDate: ticket.return_date,
      amountKes: ticket.amount_kes,
      mpesaReceipt: ticket.mpesa_receipt_number,
      issuedAt: issued,
      qrDataUrl
    });
  } catch (e) {
    console.error('Ticket generation failed:', e.message);
    res.status(503).json({ error: 'Could not generate ticket. Please try again.' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(port, () => console.log('CoachLinkBooking server listening on ' + port));
