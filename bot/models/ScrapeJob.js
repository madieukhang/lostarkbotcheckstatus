import mongoose from 'mongoose';

// Bridge collection between bot (on Railway, datacenter IP, blocked by CF)
// and loa-worker.js running on a residential-IP machine. Bot inserts
// pending jobs; worker claims them, fetches bible, writes the result back.
// Bot then polls this collection for its own jobId until status flips.
const scrapeJobSchema = new mongoose.Schema({
  url: { type: String, required: true },

  // Sanitized subset of fetch options. Anything that cannot survive a
  // JSON round trip (AbortSignal, ScraperAPI booleans, etc.) is stripped
  // before insert. Only timeoutMs is currently honored by the worker.
  options: {
    timeoutMs: { type: Number, default: null },
  },

  status: {
    type: String,
    enum: ['pending', 'in_progress', 'done', 'failed'],
    default: 'pending',
    index: true,
  },

  // Populated when status === 'done'. Body is stored as a string because
  // bible responses are JSON or HTML text, and Mongoose's Mixed type
  // would lose nested object key ordering some parsers depend on.
  result: {
    status: { type: Number, default: null },
    headers: { type: Map, of: String, default: undefined },
    body: { type: String, default: null },
  },

  // Populated when status === 'failed'.
  error: { type: String, default: null },

  // TTL: auto-delete after 1 hour. Done/failed jobs no longer matter
  // once the bot has read the result, and stale pending jobs from a
  // crashed worker should not pile up.
  createdAt: { type: Date, default: Date.now, expires: 3600 },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
});

export default mongoose.model('ScrapeJob', scrapeJobSchema, 'scrape_jobs');
