import { autoCheckChannelGuard } from './autoCheckChannelGuard.js';

/**
 * Both setup surfaces may deliberately target the same Discord channel. Share
 * one lock and one protected-ID set so their cleaners cannot race across each
 * other's send-to-pin window.
 */
export const listNotifyChannelGuard = autoCheckChannelGuard;
