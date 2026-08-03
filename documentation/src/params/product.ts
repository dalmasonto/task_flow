/**
 * SvelteKit param matcher for product slugs.
 * Matches any string that does NOT look like a version (e.g., v2.0.0).
 */
export function match(param: string): boolean {
  return !/^v\d/.test(param);
}
