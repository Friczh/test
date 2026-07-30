'use strict';

module.exports = {
  name: 'pause',
  async execute(interaction, { playerManager }) {
    const player = playerManager.get(interaction.guildId);
    if (!player.connection || !player.queue.playing) {
      await interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
      return;
    }
    const ok = player.pause();
    await interaction.reply(ok ? 'Paused.' : "Couldn't pause.");
  },
};
