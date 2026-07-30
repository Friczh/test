'use strict';

const { getSession } = require('../lib/innertube');
const { classifyInput, resolveQuery, resolvePlaylistTracks } = require('../lib/extract');
const { config } = require('../lib/config');

module.exports = {
  name: 'play',
  async execute(interaction, { playerManager }) {
    const query = interaction.options.getString('query', true);
    const member = interaction.member;
    const voiceChannel = member?.voice?.channel;

    if (!voiceChannel) {
      await interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });
      return;
    }

    await interaction.deferReply();

    const classification = classifyInput(query);
    if (classification.kind === 'unsupported') {
      await interaction.editReply("That's a radio/mix link without a specific video — link a track from it directly instead.");
      return;
    }

    // Determine session client_type up front so we bootstrap the right
    // context from the start (search has no music-specific path, so it
    // always stays WEB).
    const isMusicRequest = classification.kind !== 'search' && classification.isMusic;
    const session = await getSession({ clientType: isMusicRequest ? 'YTMUSIC' : 'WEB' });

    let tracksToQueue;
    let replyText;
    try {
      if (classification.kind === 'playlist') {
        const resolved = await resolvePlaylistTracks(
          session,
          classification.playlistId,
          classification.isMusic,
          { maxTracks: config.playlistMaxTracks }
        );
        if (resolved.length === 0) {
          await interaction.editReply("That playlist has no playable tracks.");
          return;
        }
        tracksToQueue = resolved;
        replyText = `Queued playlist: **${resolved.length}** track${resolved.length === 1 ? '' : 's'}`;
      } else {
        // 'video' or 'search' — resolveQuery re-derives this itself.
        const resolved = await resolveQuery(session, query);
        tracksToQueue = [resolved];
        replyText = `Queued: **${resolved.title}**`;
      }
    } catch (err) {
      await interaction.editReply(`Couldn't resolve that: ${err.message}`);
      return;
    }

    const player = playerManager.get(interaction.guildId);
    if (!player.connection) {
      try {
        await player.connect(voiceChannel);
      } catch (err) {
        await interaction.editReply(`Couldn't join voice channel: ${err.message}`);
        return;
      }
    }
    player.queue.voiceChannelId = voiceChannel.id;
    player.queue.textChannelId = interaction.channelId;

    const requestedBy = interaction.user.id;
    await player.enqueueMany(
      tracksToQueue.map((t) => ({
        videoId: t.videoId,
        isMusic: t.isMusic,
        title: t.title,
        requestedBy,
      }))
    );

    await interaction.editReply(replyText);
  },
};

