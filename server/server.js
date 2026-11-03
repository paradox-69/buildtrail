import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

// Temporary storage for Email OTPs
const pendingEmailOtps = new Map();

// 1. Send OTP to Email
app.post('/api/send-email-otp', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required.' });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        pendingEmailOtps.set(email, { otp, expiresAt: Date.now() + 300000 }); // 5 mins validity

        // Resend se OTP email bhejo
        await resend.emails.send({
            from: 'BuildTrail <onboarding@resend.dev>',
            to: [email],
            subject: 'Your BuildTrail Verification Code 🔑',
            html: `<p>Your verification code is: <b>${otp}</b></p><p>This code is valid for 5 minutes.</p>`
        });

        return res.json({ success: true, message: 'OTP sent to your email!' });
    } catch (err) {
        console.error('Error sending email OTP:', err);
        return res.status(500).json({ error: 'Failed to send OTP email.' });
    }
});

// 2. Verify OTP, Save to Supabase & Send Greeting Email
app.post('/api/verify-and-join', async (req, res) => {
    try {
        const { otp, userData } = req.body;
        const { email, name } = userData;

        const record = pendingEmailOtps.get(email);
        if (!record) return res.status(400).json({ error: 'OTP not requested or expired.' });
        if (Date.now() > record.expiresAt) {
            pendingEmailOtps.delete(email);
            return res.status(400).json({ error: 'OTP has expired.' });
        }
        if (record.otp !== otp) return res.status(400).json({ error: 'Invalid OTP.' });

        pendingEmailOtps.delete(email);

        // Supabase me data save karo
        const { error: dbError } = await supabase
            .from('waitlist')
            .insert([{
                name,
                phone: userData.phone,
                email,
                role: userData.role,
                stream: userData.stream,
                year: userData.year,
                university: userData.university,
                project_type: userData.projectType,
                pain: userData.pain
            }]);

        if (dbError) {
            if (dbError.code === '23505') {
                return res.status(400).json({ error: 'This email is already on the waitlist!' });
            }
            throw dbError;
        }

        // Welcome / Greeting Email bhejo
        await resend.emails.send({
            from: 'BuildTrail <onboarding@resend.dev>',
            to: [email],
            subject: 'You’re on the BuildTrail waitlist! 🚀',
            html: `<p>Hi <b>${name}</b>,</p><p>Thanks for joining the BuildTrail waitlist! We are thrilled to have you on board. We’ll notify you as soon as early access opens up.</p><p>- Team BuildTrail</p>`
        });

        return res.json({ success: true, message: 'Successfully joined waitlist!' });
    } catch (err) {
        console.error('Verification error:', err);
        return res.status(500).json({ error: 'Server error during verification.' });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
