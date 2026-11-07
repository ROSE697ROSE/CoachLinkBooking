const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
const databaseUrl = process.env.DATABASE_URL;
app.use(express.json({ limit: '20kb' }));

let pool;
let initPromise;
function db() {
  if (!databaseUrl) throw new Error('Booking database is not connected yet.');
  if (!pool) pool = new Pool({ connectionString: databaseUrl, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  return pool;
}
async function initialise() {
  if (!initPromise) initPromise = db().query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id BIGSERIAL PRIMARY KEY,
      reference VARCHAR(20) UNIQUE NOT NULL,
      departure VARCHAR(100) NOT NULL,
      destination VARCHAR(100) NOT NULL,
      travel_date DATE NOT NULL,
      passengers INTEGER NOT NULL CHECK (passengers BETWEEN 1 AND 5),
      passenger_name VARCHAR(120) NOT NULL,
      phone VARCHAR(30) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending_operator_confirmation',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  return initPromise;
}
app.get('/api/health', async (_req, res) => {
  try { await initialise(); await db().query('SELECT 1'); res.json({ ok: true, database: 'connected' }); }
  catch (e) { res.status(503).json({ ok: false, database: 'not_connected', error: e.message }); }
});
app.post('/api/bookings', async (req, res) => {
  const { from, to, travelDate, passengers, passengerName, phone } = req.body || {};
  if (![from, to, travelDate, passengerName, phone].every(v => typeof v === 'string' && v.trim()) ||
      !Number.isInteger(passengers) || passengers < 1 || passengers > 5 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(travelDate)) {
    return res.status(400).json({ error: 'Please complete all fields with valid details.' });
  }
  if (new Date(travelDate + 'T00:00:00Z') < new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')) {
    return res.status(400).json({ error: 'Travel date cannot be in the past.' });
  }
  try {
    await initialise();
    const reference = 'ENA-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    await db().query(
      'INSERT INTO bookings (reference, departure, destination, travel_date, passengers, passenger_name, phone) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [reference, from.trim(), to.trim(), travelDate, passengers, passengerName.trim(), phone.trim()]
    );
    res.status(201).json({ reference, status: 'pending_operator_confirmation' });
  } catch (e) {
    console.error('Booking save failed:', e.message);
    res.status(503).json({ error: 'Booking service is not ready. Please try again shortly.' });
  }
});
app.use(express.static(path.join(__dirname, 'public')));
app.listen(port, () => console.log('ENA Coach booking server listening on ' + port));
