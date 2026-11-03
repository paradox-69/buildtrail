import express from 'express';
import cors from 'cors';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// Session path aur client setup (Docker / Cloud compatible)
const SESSION_PATH = process.env.WA_SESSION_PATH || './.wwebjs_auth';
let waReady = false;

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
    puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--disable-gpu', '--no-zygote', '--single-process',
  '--disable-extensions', '--disable-background-networking',
  '--disable-default-apps', '--mute-audio', '--no-first-run'
]
    }
});

// QR Code generation
client.on('qr', (qr) => {
    console.log('\n--- SCAN THIS QR CODE WITH WHATSAPP ---');
    console.log('QR string:', qr);
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    waReady = true;
    console.log('✅ WhatsApp Client is ready!');
});

client.on('disconnected', (r) => {
    waReady = false;
    console.log('WhatsApp disconnected:', r);
    client.initialize();
});

client.initialize();

// In-memory store for OTPs (temporary)
const pendingOtps = new Map();

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ ok: true });
});

// Send WhatsApp OTP Route
app.post('/api/send-otp', async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) {
            return res.status(400).json({ error: 'Phone number is required' });
        }

        if (!waReady) {
            return res.status(503).json({ error: 'OTP service is starting. Please try again in a minute.' });
        }

        const numberId = await client.getNumberId(phone);
        if (!numberId) {
            return res.status(400).json({ error: 'This number is not on WhatsApp.' });
        }

        // Generate 6 digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const message = `Your BuildTrail Waitlist OTP is: *${otp}*. Valid for 5 minutes.`;

        // Check ke baad pending OTP store karo
        pendingOtps.set(phone, { otp, expiresAt: Date.now() + 300000 });

        await client.sendMessage(numberId._serialized, message);
        
        return res.json({ success: true, message: 'OTP sent successfully via WhatsApp!' });
    } catch (err) {
        console.error('Error sending OTP:', err);
        return res.status(500).json({ error: 'Failed to send OTP' });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
