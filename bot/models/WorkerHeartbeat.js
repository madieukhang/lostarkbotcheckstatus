import mongoose from 'mongoose';

// Single-document liveness signal from loa-worker.js. Worker upserts
// `lastSeenAt: now()` every ~15s. Bot reads it via getWorkerHealth() to
// decide whether the residential-IP worker is online.
//
// Distinct workerId values let multiple workers run side-by-side
// later (HA), but Phase 2 ships with a single 'default' worker.
const workerHeartbeatSchema = new mongoose.Schema({
  workerId: {
    type: String,
    required: true,
    unique: true,
    default: 'default',
  },
  lastSeenAt: { type: Date, default: Date.now },
  startedAt: { type: Date, default: Date.now },
  pid: { type: Number, default: null },
});

export default mongoose.model('WorkerHeartbeat', workerHeartbeatSchema, 'worker_heartbeats');
