// Must give the same answer as `is_safe_link` in crates/desknotes-core/src/validation.rs.
// Shared cases in tests/fixtures/links.json are checked by both test suites.
const ALLOWED = ["http:", "https:", "mailto:"];

/** Unicode White_Space, which is what Rust's `str::trim` removes (not U+FEFF). */
const EDGE_SPACE =
  /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;
/** Unicode category Cc, which is what Rust's `char::is_control` matches. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export function isSafeLink(href: string): boolean {
  const value = href.replace(EDGE_SPACE, "").toLowerCase();
  if (CONTROL.test(value)) return false;
  return ALLOWED.some((scheme) => value.startsWith(scheme));
}

/** Turn what a person typed into a link, or null if it is not acceptable. */
export function normalizeLink(input: string): string | null {
  const value = input.replace(EDGE_SPACE, "");
  if (!value) return null;
  if (isSafeLink(value)) return value;
  if (CONTROL.test(value)) return null;
  if (/^[^\s:/]+@[^\s:/]+\.[^\s:/]+$/.test(value)) return `mailto:${value}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null; // other scheme: refuse
  const candidate = `https://${value}`;
  return isSafeLink(candidate) ? candidate : null;
}
