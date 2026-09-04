import config from '../../../config.js';
import { connectDB } from '../../../db.js';
import UserPreference from '../../../models/UserPreference.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
import { getUserOcrMode, setUserOcrMode } from '../../../services/list-check/preferences.js';
import { AlertSeverity } from '../../../utils/alertEmbed.js';
import { deferEphemeralReply, editAlert } from '../../../utils/interactionReplies.js';

/** Build the private per-user OCR mode command; omission only reads the mode. */
export function createOcrModeCommandHandler({
  connectDBFn = connectDB,
  getUserLanguageFn = getUserLanguage,
  getUserOcrModeFn = getUserOcrMode,
  setUserOcrModeFn = setUserOcrMode,
} = {}) {
  return async function handleOcrModeCommand(interaction) {
    await deferEphemeralReply(interaction);
    await connectDBFn();
    const lang = await getUserLanguageFn(interaction.user.id, { UserPreferenceModel: UserPreference });
    const requested = interaction.options.getString('mode');
    if (requested === 'analysis' && config.geminiAnalysisModels.length === 0) {
      await editAlert(interaction, {
        severity: AlertSeverity.WARNING,
        ...t('dialogue.check.modeUnavailable', lang),
        lang,
      });
      return;
    }
    const mode = requested
      ? await setUserOcrModeFn(interaction.user.id, requested)
      : await getUserOcrModeFn(interaction.user.id);
    await editAlert(interaction, {
      severity: AlertSeverity.SUCCESS,
      ...t(requested ? 'dialogue.check.modeSaved' : 'dialogue.check.modeCurrent', lang, {
        mode: t(`commands.check.modes.${mode}`, lang),
      }),
      lang,
    });
  };
}
