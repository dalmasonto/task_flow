import adapter from '@sveltejs/adapter-static';
import { specraConfig } from 'specra/svelte-config';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const config = specraConfig({
  vitePreprocess: { vitePreprocess },
  kit: {
    adapter: adapter(),
    prerender: {
      entries: [
        '*',
        '/docs',
        '/docs/v1.0.0',
        '/docs/v1.0.0/about',
        '/docs/v1.0.0/getting-started',
        '/docs/v1.0.0/features',
        '/docs/v1.0.0/configuration',
        '/docs/v1.0.0/agents',
        '/docs/v1.0.0/agents/claude',
        '/docs/v1.0.0/agents/codex',
        '/docs/v1.0.0/agents/cursor',
        '/docs/v1.0.0/agents/windsurf',
        '/docs/v1.0.0/agents/cline',
        '/docs/v1.0.0/agents/continue',
        '/docs/v1.0.0/agents/copilot',
        '/docs/v1.0.0/api'
      ],
      handleHttpError: 'warn',
      handleMissingId: 'warn',
      handleUnseenRoutes: 'warn'
    }
  }
});

export default config;
