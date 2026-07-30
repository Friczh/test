'use strict';

module.exports = {
  name: 'queue',
  async execute(interaction, { queueManager }) {
    const queue = queueManager.get(interaction.guildId);
    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'list': {
        const tracks = queue.list();
        if (tracks.length === 0 && !queue.playing) {
          await interaction.reply({ content: 'Queue is empty.', ephemeral: true });
          return;
        }
        const lines = [];
        if (queue.playing) lines.push(`Now playing: **${queue.playing.title}**`);
        tracks.forEach((t, i) => lines.push(`${i + 1}. ${t.title}`));
        await interaction.reply(lines.join('\n'));
        return;
      }

      case 'remove': {
        const position = interaction.options.getInteger('position', true);
        const removed = queue.remove(position - 1);
        if (!removed) {
          await interaction.reply({ content: 'Invalid position.', ephemeral: true });
          return;
        }
        await interaction.reply(`Removed: **${removed.title}**`);
        return;
      }

      case 'swap': {
        const a = interaction.options.getInteger('position_a', true);
        const b = interaction.options.getInteger('position_b', true);
        const ok = queue.swap(a - 1, b - 1);
        await interaction.reply(ok ? `Swapped ${a} and ${b}.` : 'Invalid positions.');
        return;
      }

      case 'move': {
        const from = interaction.options.getInteger('from', true);
        const to = interaction.options.getInteger('to', true);
        const ok = queue.move(from - 1, to - 1);
        await interaction.reply(ok ? `Moved ${from} to ${to}.` : 'Invalid positions.');
        return;
      }

      case 'clear': {
        queue.clear();
        await interaction.reply('Queue cleared.');
        return;
      }

      default:
        await interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
    }
  },
};
