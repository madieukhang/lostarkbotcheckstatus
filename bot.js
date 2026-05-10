/**
 * Entry point for the Lost Ark server-status Discord bot.
 */

import {
  Client,
  Events,
  GatewayIntentBits,
} from 'discord.js';

import config from './bot/config.js';
import { createReadyHandler } from './bot/app/lifecycle.js';
import { createInteractionRouter } from './bot/app/interaction-router.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, createReadyHandler(client));
client.on(Events.InteractionCreate, createInteractionRouter({ client }));

process.on('unhandledRejection', (reason) => {
  console.error('[bot] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[bot] Uncaught exception:', err);
  process.exit(1);
});

client.login(config.token);
