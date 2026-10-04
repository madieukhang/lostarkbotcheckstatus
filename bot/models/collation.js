/**
 * The case-insensitive collation shared by list lookups and unique indexes.
 *
 * strength 2 compares strings case-insensitively while still telling
 * diacritics apart, so OCR-folded and case-shifted names land on the right
 * row without merging genuinely different characters. Indexes built with
 * this collation are the only ones Mongo can use to serve collated
 * queries, so indexes and lookups must share this exact object value.
 */
export const CASE_INSENSITIVE_COLLATION = Object.freeze({ locale: 'en', strength: 2 });
