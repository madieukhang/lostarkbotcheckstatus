/** Shared watchlist model backed by the canonical list-entry schema. */

import mongoose from 'mongoose';
import { createListEntrySchema } from './listEntrySchema.js';

const watchlistSchema = createListEntrySchema();

export default mongoose.model('watchlist', watchlistSchema, 'watchlist');
