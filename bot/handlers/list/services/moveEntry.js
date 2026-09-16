/**
 * Move an entry between collections as one transaction; no half-created
 * destination survives.
 * @param {object} args
 * @param {object} args.oldModel - source mongoose model.
 * @param {object} args.newModel - destination mongoose model.
 * @param {object} args.existing - caller's loaded source entry; its identity
 *   (addedByUserId, name, scope, guildId) is rechecked inside the transaction.
 * @param {Function} args.buildData - builds the destination fields from the
 *   reloaded source; the original `_id` is preserved on the copy.
 * @param {Function} [args.beforeWrite] - async guard run inside the
 *   transaction before the first read.
 * @returns {Promise<object>} the created destination document.
 * @throws when the source vanished or its ownership/scope changed mid-move.
 */
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
