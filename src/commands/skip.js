'use strict';

module.exports = {
  name: 'skip',
  async execute(interaction, { playerManager }) {
    const player = playerManager.get(interaction.guildId);
    if (!player.connection || !player.queue.playing) {
      await interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
      return;
    }
    player.skip();
    await interaction.reply('Skipped.');
  },
};
