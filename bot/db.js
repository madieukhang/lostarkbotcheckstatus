/**
 * db.js
 * Manages a single shared Mongoose connection to MongoDB.
 * Uses a lazy-connect pattern so the connection is established
 * on first use rather than at startup.
 */

import mongoose from 'mongoose';
import config from './config.js';

let connected = false;

/**
 * Connect to MongoDB if not already connected.
 * Safe to call multiple times – subsequent calls are no-ops.
 */
export async function connectDB() {
  if (connected) return;
  await mongoose.connect(config.mongoUri);
  connected = true;

  const { host, port, name } = mongoose.connection;
  console.log(`[db] ✅ Connected to MongoDB · host: ${host}:${port}, database: ${name}`);

  mongoose.connection.on('disconnected', () => {
    connected = false;
    console.warn('[db] ⚠️  MongoDB disconnected');
  });

  mongoose.connection.on('error', (err) => {
    console.error('[db] ❌ MongoDB error:', err.message);
  });
}
