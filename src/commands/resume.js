'use strict';

module.exports = {
  name: 'resume',
  async execute(interaction, { playerManager }) {
    const player = playerManager.get(interaction.guildId);
    if (!player.connection) {
      await interaction.reply({ content: 'Not connected to a voice channel.', ephemeral: true });
      return;
    }
    const ok = player.resume();
    await interaction.reply(ok ? 'Resumed.' : "Couldn't resume.");
  },
};
