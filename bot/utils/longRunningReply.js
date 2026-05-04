/**
 * Discord interaction webhook tokens expire after ~15 minutes. Long
 * stronghold scans can run longer than that, so after the first reply edit
 * creates a public message, keep editing the message directly with the bot
 * token instead of relying on interaction.editReply().
 */

export function createLongRunningReplyEditor(interaction) {
  let message = interaction.message || null;

  async function fetchEditableMessage(candidate = message, { allowFetchReply = false } = {}) {
    if (candidate?.edit) return candidate;

    const messageId = candidate?.id || message?.id;
    if (messageId && interaction.channel?.messages?.fetch) {
      try {
        const fetched = await interaction.channel.messages.fetch(messageId);
        if (fetched?.edit) return fetched;
      } catch (err) {
        console.warn('[long-reply] Could not fetch editable message:', err?.message || err);
      }
    }

    if (allowFetchReply && interaction.fetchReply) {
      try {
        const fetched = await interaction.fetchReply();
        if (fetched?.edit) return fetched;
        if (fetched?.id && interaction.channel?.messages?.fetch) {
          const channelFetched = await interaction.channel.messages.fetch(fetched.id);
          if (channelFetched?.edit) return channelFetched;
        }
        return fetched;
      } catch (err) {
        console.warn('[long-reply] Could not fetch interaction reply:', err?.message || err);
      }
    }

    return candidate || null;
  }

  return {
    getMessage() {
      return message;
    },

    async edit(payload) {
      const editable = await fetchEditableMessage();
      if (editable?.edit) {
        message = await editable.edit(payload);
        return message;
      }

      const edited = await interaction.editReply(payload);
      message = await fetchEditableMessage(edited, { allowFetchReply: true });
      return message;
    },
  };
}
