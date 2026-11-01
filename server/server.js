// BuildTrail backend: WhatsApp OTP waitlist + contact form.
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
const PROVIDER_NAME = (process.env.WA_PROVIDER || 'webjs').toLowerCase(); // webjs | cloud | console
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const SEND_WELCOME = (process.env.SEND_WELCOME || 'on') !== 'off';

const MIN = 60 * 1000, HOUR = 60 * MIN;
const OTP_TTL = 5 * MIN;
const MAX_ATTEMPTS = 5;                                            // wrong codes allowed per OTP
const RESEND_GAP = (Number(process.env.OTP_RESEND_GAP_SEC) || 30) * 1000; // minimum gap between codes to one number
const MAX_SENDS_PER_PHONE_PER_HOUR = 5;

// ---------- Small helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// single-line text: removes control characters, trims, limits length
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
// multi-line text: keeps line breaks
const multiline = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ').trim().slice(0, max) : '');
// name that is safe to put inside a WhatsApp message
const safeName = v => str(v, 40).replace(/[*_~`]/g, '');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^91[6-9]\d{9}$/;   // Indian mobile numbers, with country code
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

// ---------- WhatsApp providers ----------
const otpText = (name, otp) => `Hi ${name}, your BuildTrail verification code is *${otp}*. It is valid for 5 minutes. Please don’t share it with anyone.`;
const welcomeText = name => `Thanks ${name} for joining the BuildTrail waitlist! We’ll share early access and launch updates here soon.`;

async function makeProvider(name) {
  if (name === 'console') {                       // development: prints the code instead of sending it
    return {
      name, ready: () => true,
      sendOtp: async ({ phone, otp }) => console.log(`[DEV] OTP for +${phone}: ${otp}`),
      sendWelcome: async ({ phone }) => console.log(`[DEV] welcome message for +${phone}`)
    };
  }

  if (name === 'cloud') {                         // official WhatsApp Business Cloud API (recommended for live use)
    const { WA_TOKEN, WA_PHONE_NUMBER_ID, WA_OTP_TEMPLATE, WA_WELCOME_TEMPLATE } = process.env;
    if (!WA_TOKEN || !WA_PHONE_NUMBER_ID || !WA_OTP_TEMPLATE) throw new Error('WA_PROVIDER=cloud needs WA_TOKEN, WA_PHONE_NUMBER_ID and WA_OTP_TEMPLATE in .env');
    const lang = process.env.WA_TEMPLATE_LANG || 'en';
    const version = process.env.WA_GRAPH_VERSION || 'v21.0';   // check Meta's docs for the current version
    const call = async (to, template) => {
      const res = await fetch(`https://graph.facebook.com/${version}/${WA_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template })
      });
      if (!res.ok) {
        console.error('WhatsApp Cloud API error', res.status, (await res.text().catch(() => '')).slice(0, 300));
        throw new HttpError(502, 'We couldn’t send the code right now. Please try again shortly.');
      }
    };
    return {
      name, ready: () => true,
      // expects an approved "authentication" template that has the code as its body parameter and a copy-code button
      sendOtp: ({ phone, otp }) => call(phone, {
        name: WA_OTP_TEMPLATE, language: { code: lang },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: otp }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: otp }] }
        ]
      }),
      // optional: needs an approved template with the name as its only body parameter
      sendWelcome: async ({ phone, name: n }) => {
        if (!WA_WELCOME_TEMPLATE) return;
        await call(phone, { name: WA_WELCOME_TEMPLATE, language: { code: lang }, components: [{ type: 'body', parameters: [{ type: 'text', text: n }] }] });
      }
    };
  }

  // default: whatsapp-web.js (your own WhatsApp account, scanned through a QR code)
  console.warn('\n⚠️  WA_PROVIDER=webjs uses an unofficial library and your personal WhatsApp account.');
  console.warn('    WhatsApp can ban accounts that message many people this way. Fine for local testing,');
  console.warn('    but move to WA_PROVIDER=cloud (official API) before a public launch.\n');
  const pkg = (await import('whatsapp-web.js')).default;
  const qrcode = (await import('qrcode-terminal')).default;
  const client = new pkg.Client({ authStrategy: new pkg.LocalAuth() });
  let ready = false;
  client.on('qr', qr => { console.log('\n📱 Scan this QR code with the WhatsApp account that will send the codes:'); qrcode.generate(qr, { small: true }); });
  client.on('ready', () => { ready = true; console.log('✅ WhatsApp client is ready.'); });
  client.on('disconnected', reason => { ready = false; console.warn('WhatsApp client disconnected:', reason); });
  client.on('auth_failure', msg => console.error('WhatsApp authentication failed:', msg));
  client.initialize();
  const send = async (phone, text) => {
    const id = await client.getNumberId(phone);   // null when the number is not on WhatsApp
    if (!id) throw new HttpError(400, 'This number doesn’t seem to be on WhatsApp.');
    await client.sendMessage(id._serialized, text);
  };
  return {
    name, ready: () => ready,
    sendOtp: ({ phone, name: n, otp }) => send(phone, otpText(n, otp)),
    sendWelcome: ({ phone, name: n }) => send(phone, welcomeText(n))
  };
}
const provider = await makeProvider(PROVIDER_NAME);

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

const otpStore = new Map(); // phone -> { otp, name, expiresAt, attempts, sentAt }

app.get('/health', (req, res) => res.json({ ok: true, provider: provider.name, whatsappReady: provider.ready() }));

// 1. Send OTP
app.post('/api/send-otp', ipLimit('send', 20, HOUR), wrap(async (req, res) => {
  if (!provider.ready()) throw new HttpError(503, 'Verification is starting up. Please try again in a minute.');
  const name = safeName(req.body?.name);
  const phone = normalizePhone(req.body?.phone);
  if (!name) throw new HttpError(400, 'Please enter your name.');
  if (!PHONE_RE.test(phone)) throw new HttpError(400, 'Please enter a valid 10-digit mobile number.');
  if (onList.has(phone)) throw new HttpError(409, 'This number is already on the waitlist.');

  const now = Date.now(), current = otpStore.get(phone);
  if (current && now - current.sentAt < RESEND_GAP) {
    const wait = Math.ceil((RESEND_GAP - (now - current.sentAt)) / 1000);
    res.set('Retry-After', String(wait));
    throw new HttpError(429, `Please wait ${wait} seconds before asking for another code.`);
  }
  if (hit(`phone:${phone}`, MAX_SENDS_PER_PHONE_PER_HOUR, HOUR)) throw new HttpError(429, 'Too many codes requested for this number. Please try again later.');

  const otp = String(crypto.randomInt(100000, 1000000));
  try {
    await provider.sendOtp({ phone, name, otp });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error('Could not send OTP:', err.message);
    throw new HttpError(502, 'We couldn’t send the code right now. Please try again shortly.');
  }
  otpStore.set(phone, { otp, name, expiresAt: now + OTP_TTL, attempts: 0, sentAt: now });
  res.json({ success: true, message: 'Code sent to your WhatsApp.' });
}));

// 2. Verify OTP and save the waitlist entry
app.post('/api/verify-otp', ipLimit('verify', 60, 15 * MIN), wrap(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const code = str(req.body?.otp, 6);
  if (!PHONE_RE.test(phone) || !/^\d{6}$/.test(code)) throw new HttpError(400, 'Please enter the 6-digit code.');

  const clean = cleanWaitlist(req.body?.userData, phone);     // the browser's data is never trusted as it is
  if (clean.error) throw new HttpError(400, clean.error);

  const entry = otpStore.get(phone);
  if (!entry || Date.now() > entry.expiresAt) {
    otpStore.delete(phone);
    throw new HttpError(400, 'This code has expired. Please request a new one.');
  }
  if (entry.attempts >= MAX_ATTEMPTS) {
    otpStore.delete(phone);
    throw new HttpError(429, 'Too many wrong attempts. Please request a new code.');
  }
  if (!safeEqual(entry.otp, code)) {
    entry.attempts += 1;
    throw new HttpError(400, 'That code isn’t correct. Please check it and try again.');
  }

  if (!onList.has(phone)) {
    await save(FILES.waitlist, { ...clean.value, verifiedAt: new Date().toISOString() });
    waitlist.push({ ...clean.value, verifiedAt: new Date().toISOString() });
    onList.add(phone);
    if (SEND_WELCOME) provider.sendWelcome({ phone, name: safeName(clean.value.name) }).catch(e => console.warn('Welcome message failed:', e.message));
  }
  otpStore.delete(phone);
  res.json({ success: true, message: 'You’re on the waitlist.' });
}));

// 3. Contact form
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

// 4. Admin (needs ADMIN_TOKEN in .env; send it as:  Authorization: Bearer <token>)
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
  for (const [phone, e] of otpStore) if (now > e.expiresAt) otpStore.delete(phone);
  for (const [key, list] of buckets) if (!list.length || now - list[list.length - 1] > HOUR) buckets.delete(key);
}, 5 * MIN).unref();

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}  (WhatsApp provider: ${provider.name})`);
  if (IS_PROD && ALLOWED_ORIGINS.length === 0) console.warn('⚠️  ALLOWED_ORIGINS is empty, so browsers on your website will be blocked. Set it in .env.');
  if (!ADMIN_TOKEN) console.log('ℹ️  Admin routes are off. Set ADMIN_TOKEN in .env to read the waitlist.');
});