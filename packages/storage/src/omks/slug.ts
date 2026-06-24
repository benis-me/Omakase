import { randomUUID } from 'node:crypto';

/** URL/filename-safe slug from a human title. Always non-empty. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'untitled';
}

/** Short random hex suffix to disambiguate slugs. */
export function shortId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 6);
}

/** A readable, collision-resistant id for an authored doc: `<slug>-<hex>`. */
export function slugId(title: string): string {
  return `${slugify(title)}-${shortId()}`;
}
