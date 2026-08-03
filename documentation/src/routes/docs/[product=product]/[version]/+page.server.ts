import { error, redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { getCachedAllDocs, getProducts } from 'specra';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  const { product, version } = params;

  // Verify product exists
  const products = getProducts();
  const matchedProduct = products.find(p => p.slug === product);
  if (!matchedProduct) {
    throw error(404, 'Product not found');
  }

  const docs = await getCachedAllDocs(version, undefined, product);

  if (docs.length === 0) {
    const activeVersion = matchedProduct.config.activeVersion || 'v2.0.0';
    redirect(302, `${base}/docs/${product}/${activeVersion}`);
  }

  // Redirect to first doc in this product's version
  redirect(302, `${base}/docs/${product}/${version}/${docs[0].slug}`);
};
