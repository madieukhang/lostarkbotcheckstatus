/**
 * Discord interaction webhook tokens expire after ~15 minutes. Long
 * stronghold scans can run longer than that, so after the first reply edit
 * creates a public message, keep editing the message directly with the bot
 * token instead of relying on interaction.editReply().
 */

export function createLongRunningReplyEditor(interaction) {
  let message = interaction.message || null;

  return {
    getMessage() {
      return message;
    },

    async edit(payload) {
      if (message?.edit) {
        message = await message.edit(payload);
        return message;
      }

      message = await interaction.editReply(payload);
      return message;
    },
  };
}
