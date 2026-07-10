/**
 * Blacklist entries share the common list document shape and add global/server
 * scope fields so the same name can exist globally and in individual guilds.
 */

import mongoose from 'mongoose';
import { createListEntrySchema } from './listEntrySchema.js';

const blacklistSchema = createListEntrySchema({ scoped: true });

export default mongoose.model('blacklist', blacklistSchema, 'blacklist');
