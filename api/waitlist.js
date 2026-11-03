import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

const pendingEmailOtps = new Map();

export default async function handler(req, res) {
    // CORS headers allow karne ke liye
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { action, email, otp, userData } = req.body;

    try {
        // 1. Send OTP Action
        if (action === 'send-otp') {
            if (!email) return res.status(400).json({ error: 'Email is required.' });

            const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString();
            pendingEmailOtps.set(email, { otp: generatedOtp, expiresAt: Date.now() + 300000 });

            await resend.emails.send({
                from: 'BuildTrail <onboarding@resend.dev>',
                to: [email],
                subject: 'Your BuildTrail Verification Code 🔑',
                html: `<p>Your verification code is: <b>${generatedOtp}</b></p><p>This code is valid for 5 minutes.</p>`
            });

            return res.json({ success: true, message: 'OTP sent successfully!' });
        }

        // 2. Verify & Join Action
        if (action === 'verify-join') {
            if (!userData || !userData.email) {
                return res.status(400).json({ error: 'User data is required.' });
            }

            const record = pendingEmailOtps.get(userData.email);
            if (!record) return res.status(400).json({ error: 'OTP not requested or expired.' });
            if (Date.now() > record.expiresAt) {
                pendingEmailOtps.delete(userData.email);
                return res.status(400).json({ error: 'OTP has expired.' });
            }
            if (record.otp !== otp) return res.status(400).json({ error: 'Invalid OTP.' });

            pendingEmailOtps.delete(userData.email);

            // Supabase me data insert karo
            const { error: dbError } = await supabase
                .from('waitlist')
                .insert([{
                    name: userData.name,
                    phone: userData.phone,
                    email: userData.email,
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

            // Welcome Email bhejo
            await resend.emails.send({
                from: 'BuildTrail <onboarding@resend.dev>',
                to: [userData.email],
                subject: 'You’re on the BuildTrail waitlist! 🚀',
                html: `<p>Hi <b>${userData.name}</b>,</p><p>Thanks for joining the BuildTrail waitlist! We’ll notify you as soon as early access opens up.</p><p>- Team BuildTrail</p>`
            });

            return res.json({ success: true, message: 'Successfully joined waitlist!' });
        }

        return res.status(400).json({ error: 'Invalid action.' });
    } catch (err) {
        console.error('API Error:', err);
        return res.status(500).json({ error: 'Server error. Please try again.' });
    }
}