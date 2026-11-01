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
    // Outage alert for a downtime outside the weekly schedule: null while
    // none is owed, "scheduled" for a downtime first seen inside the
    // schedule, "sent" once announced; cleared when the server is back.
    outageNotice: { type: String, default: null },
    outageClaimId: { type: String, default: null },
    outageClaimUntil: { type: Date, default: null },
  },
  { timestamps: true },
);

export default mongoose.model(
  'ServerMonitorState',
  serverMonitorStateSchema,
  'server_monitor_states',
);
