#!/usr/bin/env node
/**
 * loa-worker.js
 *
 * Residential-IP sidecar for LoaLogs. The bot on Railway hits Cloudflare
 * 403 when calling lostark.bible from a datacenter IP (verified 2026-05-04:
 * 25/25 fail in prod, 10/10 pass from a home IP with the same headers).
 * This worker runs on Traine's PC, polls scrape_jobs in Mongo, fetches
 * bible from the residential IP, and writes the result back. The bot's
 * workerBibleClient picks up the result by jobId.
 *
 * Run:   node loa-worker.js
 * Stop:  Ctrl+C (graceful shutdown)
 *
 * Env: MONGODB_URI in LostArk_LoaLogs/.env (same file the bot uses).
 *
 * This file deliberately avoids importing bot/config.js, which would
 * fail validation on missing DISCORD_TOKEN / CHANNEL_ID. The worker
 * only needs MONGODB_URI.
 */

import 'dotenv/config';
import mongoose from 'mongoose';

import { claimAndProcessOne } from './bot/services/scrapeWorker.js';
import { startHeartbeat, stopHeartbeat } from './bot/services/worker/heartbeat.js';

const POLL_IDLE_MS = 1000;

let stopping = false;
let heartbeatHandle = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollLoop() {
  while (!stopping) {
    let result;
    try {
      result = await claimAndProcessOne();
    } catch (err) {
      console.error(`[worker] iteration error: ${err.message}`);
      await sleep(POLL_IDLE_MS);
      continue;
    }

    if (result.state === 'idle') {
      await sleep(POLL_IDLE_MS);
    }
  }
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('[worker] MONGODB_URI not set. Add it to LostArk_LoaLogs/.env.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const { host, name } = mongoose.connection;
  console.log(`[worker] connected to MongoDB host=${host} db=${name}`);
  console.log('[worker] polling scrape_jobs every', POLL_IDLE_MS, 'ms');

  heartbeatHandle = startHeartbeat();
  console.log('[worker] heartbeat started');

  process.on('SIGINT', async () => {
    if (stopping) return;
    stopping = true;
    console.log('\n[worker] SIGINT received, shutting down...');
    stopHeartbeat(heartbeatHandle);
    await mongoose.disconnect();
    process.exit(0);
  });

  await pollLoop();
}

main().catch(async (err) => {
  console.error('[worker] fatal:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
