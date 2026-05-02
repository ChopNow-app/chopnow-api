import DOMPurify from 'isomorphic-dompurify';

/**
 * Strip ALL HTML tags. Use for fields where HTML should never be rendered:
 *   - vendor.description (Story 2.1)
 *   - menu item names (Story 2.2, 2.3)
 *   - dispute messages (Story 6.3)
 *   - rider names, phone display labels
 *
 * Returns a plain-text string — safe to insert anywhere.
 */
export function stripHtml(input: string): string {
  if (!input) return '';
  return DOMPurify.sanitize(input, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
}

/**
 * Allow a tiny subset of formatting tags. Use ONLY when admin-authored content
 * needs minimal formatting (e.g. announcement banners).
 *
 * Never use this for user-submitted content unless you've thought hard about it.
 */
export function sanitizeBasicHtml(input: string): string {
  if (!input) return '';
  return DOMPurify.sanitize(input, {
    ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'br', 'p', 'a'],
    ALLOWED_ATTR: ['href', 'title'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  });
}
