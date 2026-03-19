export function normalizeCharacterName(raw) {
  const value = raw.trim();
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

export function getInteractionDisplayName(interaction) {
  const member = interaction.member;
  if (member && typeof member === 'object') {
    if ('displayName' in member && typeof member.displayName === 'string' && member.displayName.trim()) {
      return member.displayName.trim();
    }
    if ('nick' in member && typeof member.nick === 'string' && member.nick.trim()) {
      return member.nick.trim();
    }
  }

  return interaction.user.globalName?.trim() || interaction.user.username;
}

export function getAddedByDisplay(entry) {
  return entry?.addedByDisplayName?.trim() || entry?.addedByName?.trim() || '';
}
