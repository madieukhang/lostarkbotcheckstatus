/** Shared whitelist model backed by the canonical list-entry schema. */

import mongoose from 'mongoose';
import { createListEntrySchema } from './listEntrySchema.js';

const whitelistSchema = createListEntrySchema();

export default mongoose.model('whitelist', whitelistSchema, 'whitelist');
