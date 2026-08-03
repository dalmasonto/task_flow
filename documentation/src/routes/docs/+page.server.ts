import { redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import config from '../../../specra.config.json';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
  const activeVersion = config.site?.activeVersion || 'v2.0.0';
  redirect(302, `${base}/docs/${activeVersion}`);
};
