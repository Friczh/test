'use strict';

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} = require('discord.js');

const PAGE_SIZE = 25;
// Root cause of the 50035 crash: replying with a plain string built from
// `tracks.map(...).join('\n')` has no length cap -- a queue past ~40-60
// tracks (title-length dependent) blows past Discord's 2000-char message
// content limit and the reply throws instead of sending. Embeds cap at
// 4096 chars for description, but the real fix is just not dumping the
// whole queue into one message at all -- paginate it.
const COLLECTOR_TIMEOUT_MS = 5 * 60 * 1000;

function buildQueuePage(queue, tracks, page, totalPages) {
  const start = page * PAGE_SIZE;
  const pageTracks = tracks.slice(start, start + PAGE_SIZE);
  const lines = pageTracks.map((t, i) => `${start + i + 1}. ${t.title}`);

  const embed = new EmbedBuilder()
    .setTitle('Queue')
    .setColor(0x5865f2)
    .setDescription(lines.length ? lines.join('\n') : '*(nothing on this page)*')
    .setFooter({ text: `Page ${page + 1}/${totalPages} · ${tracks.length} track${tracks.length === 1 ? '' : 's'} queued` });

  if (queue.playing) {
    embed.addFields({ name: 'Now playing', value: queue.playing.title });
  }

  return embed;
}

function buildQueueRow(page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('queue_prev')
      .setLabel('◀ Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId('queue_next')
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1)
  );
}

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

        let page = 0;
        const totalPages = Math.max(1, Math.ceil(tracks.length / PAGE_SIZE));
        const embed = buildQueuePage(queue, tracks, page, totalPages);
        const components = totalPages > 1 ? [buildQueueRow(page, totalPages)] : [];

        const response = await interaction.reply({ embeds: [embed], components, withResponse: true });
        if (totalPages <= 1) return;

        const message = response.resource?.message ?? await interaction.fetchReply();
        const collector = message.createMessageComponentCollector({
          componentType: ComponentType.Button,
          time: COLLECTOR_TIMEOUT_MS,
        });

        collector.on('collect', async (button) => {
          if (button.user.id !== interaction.user.id) {
            await button.reply({ content: 'Only the person who ran this command can page through it.', ephemeral: true });
            return;
          }
          page += button.customId === 'queue_next' ? 1 : -1;
          page = Math.max(0, Math.min(page, totalPages - 1));
          await button.update({
            embeds: [buildQueuePage(queue, queue.list(), page, totalPages)],
            components: [buildQueueRow(page, totalPages)],
          });
        });

        collector.on('end', async () => {
          const disabledRow = buildQueueRow(page, totalPages);
          disabledRow.components.forEach((b) => b.setDisabled(true));
          await interaction.editReply({ components: [disabledRow] }).catch(() => {});
        });
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
