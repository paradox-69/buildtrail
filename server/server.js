import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// Supabase credentials direct configured hain
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://edqfgxeynzwefwjzmdwb.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'sb_secret_4yD-iLbGqvkukVbcty8fOg_kecsQf1a-';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Health check route[cite: 4]
app.get('/health', (req, res) => {
    res.json({ ok: true });
});

// Save to Supabase Waitlist Table Route (OTP verification ke baad call hoga)
app.post('/api/save-waitlist', async (req, res) => {
    try {
        const { userData } = req.body;
        if (!userData || !userData.email) {
            return res.status(400).json({ error: 'User data is required.' });
        }

        const { email, name } = userData;

        // Supabase database me data insert karo[cite: 4]
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

        return res.json({ success: true, message: 'Successfully joined waitlist!' });
    } catch (err) {
        console.error('Save waitlist error:', err);
        return res.status(500).json({ error: 'Server error while saving to waitlist.' });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});