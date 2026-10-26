// Points <a data-brand-link="other|home|privacy"> at the brand site (URL lives in lib/brand.js only).
import { brandUrls } from '../../lib/brand.js';

export function wireBrandLinks(root = document) {
  const urls = /** @type {Record<string, string>} */ (brandUrls());
  root.querySelectorAll('a[data-brand-link]').forEach((a) => {
    const url = urls[a.getAttribute('data-brand-link') || ''];
    if (url) a.setAttribute('href', url);
  });
}
