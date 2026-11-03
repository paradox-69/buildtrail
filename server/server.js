import express from 'express';
import cors from 'cors';

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// Temporary storage for OTPs
const pendingOtps = new Map();

// Health check
app.get('/health', (req, res) => {
    res.json({ ok: true });
});

// Send Email OTP Route
app.post('/api/send-otp', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        // Generate 6 digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        pendingOtps.set(email, { otp, expiresAt: Date.now() + 300000 });

        console.log(`🔑 OTP for ${email}: ${otp}`); // Render logs me dikh jayega testing ke liye

        // Yahan aap Nodemailer ya Resend API lagakar user ki email par OTP bhej sakte hain
        return res.json({ success: true, message: 'OTP sent successfully to email!' });
    } catch (err) {
        console.error('Error sending OTP:', err);
        return res.status(500).json({ error: 'Failed to send OTP' });
    }
});

// Verify OTP Route
app.post('/api/verify-otp', (req, res) => {
    const { email, otp } = req.body;
    const record = pendingOtps.get(email);

    if (!record) {
        return res.status(400).json({ error: 'OTP not requested or expired.' });
    }

    if (Date.now() > record.expiresAt) {
        pendingOtps.delete(email);
        return res.status(400).json({ error: 'OTP has expired.' });
    }

    if (record.otp !== otp) {
        return res.status(400).json({ error: 'Invalid OTP.' });
    }

    pendingOtps.delete(email);
    return res.json({ success: true, message: 'Verified successfully!' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
