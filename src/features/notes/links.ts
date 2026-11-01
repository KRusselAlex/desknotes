// Same rule as `is_safe_link` in crates/desknotes-core/src/validation.rs.
const ALLOWED = ["http:", "https:", "mailto:"];

export function isSafeLink(href: string): boolean {
  const lower = href.trim().toLowerCase();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(lower)) return false;
  return ALLOWED.some((scheme) => lower.startsWith(scheme));
}

/** Turn what a person typed into a link, or null if it is not acceptable. */
export function normalizeLink(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  if (isSafeLink(value)) return value;
  if (/^[^\s:/]+@[^\s:/]+\.[^\s:/]+$/.test(value)) return `mailto:${value}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null; // other scheme: refuse
  return `https://${value}`;
}
