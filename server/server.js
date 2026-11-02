// BuildTrail backend: Waitlist database & Contact form storage.
// Run: npm install && npm start   (needs Node 18 or newer, "type": "module" in package.json)
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config();

// ---------- Settings (all can be changed in .env) ----------
const PORT = Number(process.env.PORT) || 5000;
const IS_PROD = process.env.NODE_ENV === 'production';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');

const MIN = 60 * 1000, HOUR = 60 * MIN;

// ---------- Small helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// single-line text: removes control characters, trims, limits length
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
// multi-line text: keeps line breaks
const multiline = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ').trim().slice(0, max) : '');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ROLES = ['Student', 'Project guide or faculty', 'Freelance developer', 'Something else'];
const YEARS = ['1st year', '2nd year', '3rd year', '4th year', 'Postgraduate', 'Recently graduated', 'Not a student'];
const PROJECT_TYPES = ['Software', 'Hardware or embedded', 'Both', 'Not sure yet'];
const TOPICS = ['Pilot with my team', 'Using BuildTrail in my college', 'Feedback or an idea', 'Partnership', 'Something else'];

function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length === 10 ? '91' + d : d;
}
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---------- Rate limiting (in memory) ----------
const buckets = new Map();
function hit(key, limit, windowMs) {            // returns 0 if allowed, else seconds to wait
  const now = Date.now();
  const list = (buckets.get(key) || []).filter(t => now - t < windowMs);
  if (list.length >= limit) { buckets.set(key, list); return Math.max(1, Math.ceil((windowMs - (now - list[0])) / 1000)); }
  list.push(now); buckets.set(key, list);
  return 0;
}
const ipLimit = (name, max, windowMs) => (req, res, next) => {
  const wait = hit(`${name}:${req.ip}`, max, windowMs);
  if (wait) { res.set('Retry-After', String(wait)); return res.status(429).json({ error: 'Too many requests. Please try again in a little while.' }); }
  next();
};

// ---------- Storage: one JSON line per record, survives restarts ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const FILES = { waitlist: path.join(DATA_DIR, 'waitlist.ndjson'), contacts: path.join(DATA_DIR, 'contacts.ndjson') };
function readAll(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}
const waitlist = readAll(FILES.waitlist);
const contacts = readAll(FILES.contacts);
const onList = new Set(waitlist.map(u => u.phone));
const save = (file, record) => fs.promises.appendFile(file, JSON.stringify(record) + '\n');

// ---------- Validation ----------
function cleanWaitlist(u, phone) {
  u = u && typeof u === 'object' ? u : {};
  const v = {
    name: str(u.name, 80), email: str(u.email, 120).toLowerCase(), role: str(u.role, 40), stream: str(u.stream, 80),
    year: str(u.year, 30), university: str(u.university, 120), projectType: str(u.projectType, 30), pain: multiline(u.pain, 600)
  };
  if (!v.name) return { error: 'Please enter your name.' };
  if (!EMAIL_RE.test(v.email)) return { error: 'Please enter a valid email address.' };
  if (!ROLES.includes(v.role)) return { error: 'Please choose who you are.' };
  if (!v.stream) return { error: 'Please enter your stream or branch.' };
  if (!YEARS.includes(v.year)) return { error: 'Please choose your academic year.' };
  if (!v.university) return { error: 'Please enter your university or college.' };
  if (v.projectType && !PROJECT_TYPES.includes(v.projectType)) return { error: 'Please choose a valid project type.' };
  if (u.consent !== true) return { error: 'Please agree to be contacted to join the waitlist.' };
  return { value: { ...v, phone, consent: true } };
}

// ---------- App ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY) || 0);   // set TRUST_PROXY=1 when behind Render, Railway, Nginx, etc.
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);                              // non-browser tools
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    if (!IS_PROD && ALLOWED_ORIGINS.length === 0) return cb(null, true); // local development
    cb(null, false);
  }
}));
app.use(express.json({ limit: '20kb' }));

app.get('/health', (req, res) => res.json({ ok: true }));

// 1. Waitlist endpoint (Called after Firebase phone authentication succeeds on frontend)
app.post('/api/waitlist', ipLimit('waitlist', 10, HOUR), wrap(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const clean = cleanWaitlist(req.body, phone);
  if (clean.error) throw new HttpError(400, clean.error);

  if (!onList.has(phone)) {
    const record = { ...clean.value, verifiedAt: new Date().toISOString() };
    await save(FILES.waitlist, record);
    waitlist.push(record);
    onList.add(phone);
  }
  res.json({ success: true, message: 'You’re on the waitlist.' });
}));

// 2. Contact form
app.post('/api/contact', ipLimit('contact', 10, HOUR), wrap(async (req, res) => {
  const b = req.body || {};
  const rec = { name: str(b.name, 80), email: str(b.email, 120).toLowerCase(), topic: str(b.topic, 60), message: multiline(b.message, 1500) };
  if (!rec.name || !rec.message) throw new HttpError(400, 'Please fill in your name and message.');
  if (!EMAIL_RE.test(rec.email)) throw new HttpError(400, 'Please enter a valid email address.');
  if (!TOPICS.includes(rec.topic)) throw new HttpError(400, 'Please choose a topic.');
  rec.submittedAt = new Date().toISOString();
  await save(FILES.contacts, rec);
  contacts.push(rec);
  res.json({ success: true, message: 'Message received.' });
}));

// 3. Admin (needs ADMIN_TOKEN in .env; send it as:  Authorization: Bearer <token>)
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(404).json({ error: 'Not found' });
  const h = req.get('authorization') || '';
  if (!h.startsWith('Bearer ') || !safeEqual(h.slice(7), ADMIN_TOKEN)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
function sendCsv(res, rows, cols, filename) {
  const cell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; }; // stops spreadsheet formula injection
  const csv = [cols.join(',')].concat(rows.map(r => cols.map(c => cell(r[c])).join(','))).join('\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` }).send(csv);
}
app.get('/api/admin/waitlist', requireAdmin, (req, res) =>
  req.query.format === 'csv'
    ? sendCsv(res, waitlist, ['verifiedAt', 'name', 'phone', 'email', 'role', 'stream', 'year', 'university', 'projectType', 'pain'], 'waitlist.csv')
    : res.json(waitlist));
app.get('/api/admin/contacts', requireAdmin, (req, res) =>
  req.query.format === 'csv'
    ? sendCsv(res, contacts, ['submittedAt', 'name', 'email', 'topic', 'message'], 'contacts.csv')
    : res.json(contacts));

// ---------- Errors ----------
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'Invalid request.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// ---------- Housekeeping ----------
setInterval(() => {
  const now = Date.now();
  for (const [key, list] of buckets) if (!list.length || now - list[list.length - 1] > HOUR) buckets.delete(key);
}, 5 * MIN).unref();

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  if (IS_PROD && ALLOWED_ORIGINS.length === 0) console.warn('⚠️  ALLOWED_ORIGINS is empty, so browsers on your website will be blocked. Set it in .env.');
  if (!ADMIN_TOKEN) console.log('ℹ️  Admin routes are off. Set ADMIN_TOKEN in .env to read the waitlist.');
});