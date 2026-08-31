/**
 * Entry point for the Lost Ark server-status Discord bot.
 */

import {
  Client,
  Events,
  GatewayIntentBits,
} from 'discord.js';

import config from './bot/config.js';
import {
  installDiscordGatewayDiagnostics,
  startDiscordLogin,
} from './bot/app/discord-startup.js';
import { createReadyHandler } from './bot/app/lifecycle.js';
import { createInteractionRouter } from './bot/app/interaction-router.js';
import {
  createProcessTerminator,
  installProcessLifecycle,
} from './bot/app/process-lifecycle.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const terminate = createProcessTerminator({ client });
installProcessLifecycle({ terminate });
installDiscordGatewayDiagnostics(client);

client.once(Events.ClientReady, () => {
  void createReadyHandler(client)().catch((error) => terminate({
    label: 'Ready bootstrap failed',
    error,
    exitCode: 1,
  }));
});
client.on(Events.InteractionCreate, createInteractionRouter({ client }));

void startDiscordLogin({ client, token: config.token, terminate });
