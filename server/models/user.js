import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true, unique: true },
  email: { type: String, required: true },
  role: { type: String },
  stream: { type: String },
  year: { type: String },
  university: { type: String },
  projectType: { type: String },
  pain: { type: String },
  verifiedAt: { type: Date, default: Date.now }
});

export default mongoose.model('WaitlistUser', userSchema);