/** Clear a single menu selection while preserving the parent card and other controls. */
export function resetSelectMenu(interaction, customId) {
  const components = interaction.message.components.map(row => {
    const data = row.toJSON?.() || row;
    return {
      ...data,
      components: data.components.map(component => component.custom_id === customId
        ? { ...component, options: component.options.map(option => ({ ...option, default: false })) }
        : component),
    };
  });
  return interaction.update({ components });
}
