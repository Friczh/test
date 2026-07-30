'use strict';

const { Client, GatewayIntentBits, Collection } = require('discord.js');
const { commands } = require('./lib/commandDefs');
const { QueueManager } = require('./lib/queueManager');
const { PlayerManager } = require('./lib/player');
const { waitForReady: waitForPotProvider } = require('./lib/potProvider');
const { startHealthServer } = require('./lib/health');

const REQUIRED_ENV = ['DISCORD_TOKEN', 'YOUTUBE_COOKIES_BASE64'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// Started immediately, not inside 'ready' below -- Render needs
// something listening on $PORT as soon as the container starts, or the
// deploy can be marked unhealthy during the bgutil-pot-boot +
// Discord-login window, before the bot itself is at fault for anything.
startHealthServer(() => client.isReady());

const queueManager = new QueueManager();
const playerManager = new PlayerManager(queueManager);
const ctx = { queueManager, playerManager };

const commandHandlers = new Collection();
for (const file of ['play', 'skip', 'pause', 'resume', 'leave', 'queue']) {
  const handler = require(`./commands/${file}`);
  commandHandlers.set(handler.name, handler);
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    await waitForPotProvider();
    console.log('POT provider is ready.');
  } catch (err) {
    console.error('POT provider health check failed:', err.message);
    // Keep running — playback commands will surface the real error per-track
    // rather than crash-looping the whole bot over a transient sidecar hiccup.
  }

  try {
    // client.application.commands.set() (rather than a manually-supplied
    // application ID) uses this client's own authenticated application ID,
    // which avoids the hard-to-read 400 Discord returns for a missing/wrong
    // application ID.
    await client.application.commands.set(commands);
    console.log(`Registered ${commands.length} global slash commands.`);
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const handler = commandHandlers.get(interaction.commandName);
  if (!handler) return;

  try {
    await handler.execute(interaction, ctx);
  } catch (err) {
    console.error(`Error handling /${interaction.commandName}:`, err);
    const payload = { content: 'Something went wrong running that command.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

client.on('voiceStateUpdate', (oldState, newState) => {
  // Auto-leave when the bot ends up alone in a voice channel.
  const guildId = oldState.guild.id;
  if (!playerManager.has(guildId)) return;
  const player = playerManager.get(guildId);
  const channelId = player.queue.voiceChannelId;
  if (!channelId) return;
  const channel = oldState.guild.channels.cache.get(channelId);
  if (!channel) return;
  const humanMembers = channel.members.filter((m) => !m.user.bot);
  if (humanMembers.size === 0) {
    playerManager.delete(guildId);
  }
});

client.login(process.env.DISCORD_TOKEN);
