import mongoose from 'mongoose';

const serverMonitorStateSchema = new mongoose.Schema(
  {
    serverName: {
      type: String,
      required: true,
      unique: true,
    },
    lastStatus: { type: String, default: null },
    lastCheckTime: { type: Date, default: null },
    lastAlertTime: { type: Date, default: null },
    recoveryPending: { type: Boolean, default: false },
    alertClaimId: { type: String, default: null },
    alertClaimUntil: { type: Date, default: null },
  },
  { timestamps: true },
);

export default mongoose.model(
  'ServerMonitorState',
  serverMonitorStateSchema,
  'server_monitor_states',
);
