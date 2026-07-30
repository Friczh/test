'use strict';

module.exports = {
  name: 'leave',
  async execute(interaction, { playerManager }) {
    if (!playerManager.has(interaction.guildId)) {
      await interaction.reply({ content: 'Not connected to a voice channel.', ephemeral: true });
      return;
    }
    playerManager.delete(interaction.guildId);
    await interaction.reply('Left the voice channel and cleared the queue.');
  },
};
