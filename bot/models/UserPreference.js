import mongoose from 'mongoose';

const userPreferenceSchema = new mongoose.Schema(
  {
    discordId: { type: String, required: true, unique: true, index: true },
    discordUsername: { type: String, default: '' },
    discordGlobalName: { type: String, default: '' },
    discordDisplayName: { type: String, default: '' },
    language: { type: String, default: 'en' },
  },
  {
    timestamps: true,
  }
);

export default mongoose.model('UserPreference', userPreferenceSchema);
