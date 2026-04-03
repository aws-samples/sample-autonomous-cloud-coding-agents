import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://aws-samples.github.io',
  base: '/sample-autonomous-cloud-coding-agents',
  integrations: [
    starlight({
      title: 'ABCA Docs',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/aws-samples/sample-autonomous-cloud-coding-agents',
        },
      ],
      components: {
        Search: './src/components/Search.astro',
      },
      head: [
        {
          tag: 'script',
          content:
            "(function(){try{if(typeof localStorage!=='undefined'){var k='starlight-theme';if(localStorage.getItem(k)===null)localStorage.setItem(k,'dark');}}catch(e){}})();",
        },
      ],
      sidebar: [
        { label: 'Introduction', slug: 'index' },
        {
          label: 'Developer Guide',
          items: [
            { slug: 'developer-guide/introduction' },
            { slug: 'developer-guide/installation' },
            { slug: 'developer-guide/repository-preparation' },
            { slug: 'developer-guide/project-structure' },
            { slug: 'developer-guide/contributing' },
          ],
        },
        {
          label: 'User Guide',
          items: [
            { slug: 'user-guide/introduction' },
            { slug: 'user-guide/overview' },
            { slug: 'user-guide/prerequisites' },
            { slug: 'user-guide/authentication' },
            { slug: 'user-guide/repository-onboarding' },
            { slug: 'user-guide/using-the-rest-api' },
            { slug: 'user-guide/using-the-cli' },
            { slug: 'user-guide/webhook-integration' },
            { slug: 'user-guide/task-lifecycle' },
            { slug: 'user-guide/what-the-agent-does' },
            { slug: 'user-guide/viewing-logs' },
            { slug: 'user-guide/tips' },
            { label: 'Prompt guide', slug: 'user-guide/prompt-guide' },
          ],
        },
        {
          label: 'Roadmap',
          autogenerate: { directory: 'roadmap' },
        },
        { label: 'Design', autogenerate: { directory: 'design' } },
      ],
    }),
  ],
});
