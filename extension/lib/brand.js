// Links to the author's brand site (welcome / uninstall / privacy pages, "other extensions").
// Pure module: no chrome.* calls.
//
// TODO(release): replace BASE with the real GitHub Pages address of the brand site
// (see site/README.md, «Какие URL вставить в расширения»). It is the ONLY place to change:
// background.js, the popup/options footer and the e2e test all read it from here.
// Then set "homepage_url" in extension/manifest.json to the same value — test/brand.test.js
// fails until both match.

/** Base URL of the brand site, with a trailing slash. */
export const BASE = 'https://ddvdvt.github.io/';

/** Page slug of this extension on the brand site. */
export const SLUG = 'read-later';

/**
 * All brand URLs for an extension.
 * @param {string} [base]
 * @param {string} [slug]
 */
export function brandUrls(base = BASE, slug = SLUG) {
  const b = base.endsWith('/') ? base : `${base}/`;
  return {
    home: b,
    welcome: `${b}welcome/${slug}.html`,
    bye: `${b}bye/${slug}.html`,
    privacy: `${b}privacy/${slug}.html`,
    other: `${b}#${slug}`,
  };
}

/**
 * URL to open after chrome.runtime.onInstalled, or null. Only a fresh install opens a tab;
 * updates, Chrome updates and shared-module events stay silent.
 * @param {string | undefined} reason chrome.runtime.OnInstalledReason
 * @param {string} [base]
 * @param {string} [slug]
 * @returns {string | null}
 */
export function welcomeUrlFor(reason, base = BASE, slug = SLUG) {
  return reason === 'install' ? brandUrls(base, slug).welcome : null;
}
