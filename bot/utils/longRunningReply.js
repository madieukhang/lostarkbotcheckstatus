/**
 * Discord interaction webhook tokens expire after ~15 minutes. Long
 * stronghold scans can run longer than that, so after the first reply edit
 * creates a public message, keep editing the message directly with the bot
 * token instead of relying on interaction.editReply().
 */

export function createLongRunningReplyEditor(interaction) {
  let message = interaction.message || null;

  function isEditable(candidate) {
    return typeof candidate?.edit === 'function';
  }

  async function fetchChannelMessage(messageId) {
    if (!messageId || !interaction.channel?.messages?.fetch) return null;
    try {
      return await interaction.channel.messages.fetch(messageId);
    } catch (err) {
      console.warn('[long-reply] Could not fetch editable message:', err?.message || err);
      return null;
    }
  }

  async function fetchInteractionReply() {
    if (typeof interaction.fetchReply !== 'function') return null;
    try {
      const fetched = await interaction.fetchReply();
      if (isEditable(fetched)) return fetched;
      return await fetchChannelMessage(fetched?.id) || fetched;
    } catch (err) {
      console.warn('[long-reply] Could not fetch interaction reply:', err?.message || err);
      return null;
    }
  }

  async function fetchEditableMessage(candidate = message, { allowFetchReply = false } = {}) {
    if (isEditable(candidate)) return candidate;
    const messageId = candidate?.id || message?.id;
    const channelMessage = await fetchChannelMessage(messageId);
    if (isEditable(channelMessage)) return channelMessage;
    if (allowFetchReply) return await fetchInteractionReply() || candidate || null;
    return candidate || null;
  }

  return {
    getMessage() {
      return message;
    },

    async edit(payload) {
      const editable = await fetchEditableMessage();
      if (isEditable(editable)) {
        message = await editable.edit(payload);
        return message;
      }

      const edited = await interaction.editReply(payload);
      message = await fetchEditableMessage(edited, { allowFetchReply: true });
      return message;
    },
  };
}
