/**
 * db.js
 * Manages a single shared Mongoose connection to MongoDB.
 * connectDB() is idempotent: the ready handler in app/lifecycle.js opens
 * the connection at startup, and handlers call it again before database
 * work to reuse the live connection or reconnect after a drop.
 */

import mongoose from 'mongoose';
import config from './config.js';

let connected = false;
let connectionPromise = null;
let listenersAttached = false;

/**
 * Connect to MongoDB if not already connected.
 * Overlapping callers share one attempt; failed attempts remain retryable.
 */
export async function connectDB() {
  if (connectionPromise) return connectionPromise;
  if (connected) return;
  connectionPromise = Promise.resolve().then(openConnection).finally(() => {
    connectionPromise = null;
  });
  return connectionPromise;
}

async function openConnection() {
  await mongoose.connect(config.mongoUri);
  connected = true;

  const { host, port, name } = mongoose.connection;
  console.log(`[db] ✅ Connected to MongoDB · host: ${host}:${port}, database: ${name}`);

  if (!listenersAttached) {
    listenersAttached = true;
    mongoose.connection.on('disconnected', () => {
      connected = false;
      console.warn('[db] ⚠️  MongoDB disconnected');
    });

    mongoose.connection.on('error', (err) => {
      console.error('[db] ❌ MongoDB error:', err.message);
    });
  }
}

export async function disconnectDB() {
  if (connectionPromise) await connectionPromise.catch(() => {});
  if (mongoose.connection.readyState === 0) {
    connected = false;
    return;
  }
  await mongoose.disconnect();
  connected = false;
}
