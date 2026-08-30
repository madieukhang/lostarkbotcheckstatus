export function getChannelGuildId(channel) {
  const guildId = channel?.guildId ?? channel?.guild?.id;
  return guildId == null ? null : String(guildId);
}

export function channelBelongsToGuild(channel, guildId) {
  const actualGuildId = getChannelGuildId(channel);
  const expectedGuildId = guildId == null ? null : String(guildId);
  return Boolean(
    actualGuildId &&
    expectedGuildId &&
    actualGuildId === expectedGuildId
  );
}
