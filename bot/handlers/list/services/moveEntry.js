/** Move an entry between collections as one transaction; no half-created destination survives. */
export async function moveListEntry({ oldModel, newModel, existing, buildData, beforeWrite = async () => {} }) {
  return oldModel.db.transaction(async session => {
    await beforeWrite();
    const source = await oldModel.findById(existing._id).session(session);
    if (!source) throw new Error('The source entry no longer exists. Reload before editing.');
    if (source.addedByUserId !== existing.addedByUserId || source.name !== existing.name
      || source.scope !== existing.scope || source.guildId !== existing.guildId) {
      throw new Error('The source ownership or scope changed. Reload before editing.');
    }
    // Preserve identity so an approval interrupted after commit can recognize
    // the completed move without creating another destination or applying twice.
    const [moved] = await newModel.create([{ ...buildData(source), _id: source._id }], { session });
    const removed = await oldModel.deleteOne({ _id: source._id }, { session });
    if (removed.deletedCount !== 1) throw new Error('The source entry changed while moving. Retry the edit.');
    return moved;
  });
}
