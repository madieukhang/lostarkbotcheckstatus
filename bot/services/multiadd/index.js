/**
 * services/multiadd/index.js
 * Aggregate re-export surface for the multiadd sub-package · template
 * generator + uploaded-file parser. Callers import via
 * `services/multiadd` so internal file moves don't ripple.
 */

export {
  buildMultiaddTemplate,
  MULTIADD_MAX_ROWS,
} from './template.js';

export {
  parseMultiaddFile,
} from './parser.js';
