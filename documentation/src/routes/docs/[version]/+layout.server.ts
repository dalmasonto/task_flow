import { getCachedVersions, getCachedAllDocs, getEffectiveConfig, getI18nConfig, getVersionsMeta, getProducts, loadVersionConfig } from 'specra';
import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ params }) => {
  const { version } = params;

  // Route disambiguation: if this "version" is actually a product slug,
  // the +page.server.ts will handle the redirect. The layout still needs
  // to return data for the version case.
  const products = getProducts();
  const isProduct = products.some(p => p.slug === version);
  if (isProduct) {
    // Return minimal data — the page will redirect before rendering
    return { allDocs: [], versions: [], versionsMeta: [], config: getEffectiveConfig(''), products };
  }

  const i18nConfig = getI18nConfig();
  const defaultLocale = i18nConfig?.defaultLocale || 'en';

  // Block access to hidden versions — redirect to active version
  const currentVersionConfig = loadVersionConfig(version);
  if (currentVersionConfig?.hidden) {
    const config = getEffectiveConfig(version);
    const activeVersion = config.site?.activeVersion || 'v1.0.0';
    throw redirect(302, `/docs/${activeVersion}`);
  }

  const allDocs = await getCachedAllDocs(version, defaultLocale);
  const versions = getCachedVersions();
  const config = getEffectiveConfig(version);
  const versionsMeta = getVersionsMeta(versions);

  return {
    allDocs,
    versions,
    versionsMeta,
    config,
    products,
    versionBanner: currentVersionConfig?.banner,
  };
};
