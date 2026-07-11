/**
 * Action choices for /la-setup config, with RaidManage-style state-based
 * visibility: a toggle only appears in autocomplete when it would change state.
 */

export const SETUP_ACTION_CHOICES = Object.freeze([
  { value: 'show', labelKey: 'show' },
  { value: 'set-auto-channel', labelKey: 'setAutoChannel' },
  { value: 'set-notify-channel', labelKey: 'setNotifyChannel' },
  { value: 'set-language', labelKey: 'setLanguage' },
  { value: 'set-default-scope', labelKey: 'setDefaultScope' },
  { value: 'cleanup-on', labelKey: 'cleanupOn' },
  { value: 'cleanup-off', labelKey: 'cleanupOff' },
  { value: 'notify-on', labelKey: 'notifyOn' },
  { value: 'notify-off', labelKey: 'notifyOff' },
  { value: 'repin', labelKey: 'repin' },
]);

export function isSetupActionVisible(choice, state) {
  const { cleanupEnabled = false, notifyEnabled = true, autoChannelSet = false } = state || {};
  switch (choice.value) {
    // Cleanup is meaningless without an auto-channel, so hide both toggles then.
    case 'cleanup-on':
      return autoChannelSet && !cleanupEnabled;
    case 'cleanup-off':
      return autoChannelSet && cleanupEnabled;
    case 'notify-on':
      return !notifyEnabled;
    case 'notify-off':
      return notifyEnabled;
    default:
      return true;
  }
}

const defaultNormalize = (value) => String(value || '').trim().toLowerCase();

export function buildSetupActionChoices({ needle = '', state, t, lang, normalize = defaultNormalize }) {
  const n = normalize(needle);
  return SETUP_ACTION_CHOICES
    .filter((choice) => isSetupActionVisible(choice, state))
    .map((choice) => ({ name: t(`dialogue.setup.actions.${choice.labelKey}`, lang), value: choice.value }))
    .filter((choice) => !n || normalize(choice.name).includes(n) || normalize(choice.value).includes(n))
    .slice(0, 25);
}
