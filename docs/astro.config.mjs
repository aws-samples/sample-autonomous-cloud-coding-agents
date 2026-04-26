import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { remarkMermaid } from './plugins/remark-mermaid.mjs';

export default defineConfig({
  site: 'https://aws-samples.github.io',
  base: '/sample-autonomous-cloud-coding-agents',
  markdown: {
    remarkPlugins: [remarkMermaid],
  },
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
        SiteTitle: './src/components/SiteTitle.astro',
        Sidebar: './src/components/Sidebar.astro',
      },
      head: [
        {
          tag: 'script',
          content:
            "(function(){try{if(typeof localStorage!=='undefined'){var k='starlight-theme';if(localStorage.getItem(k)===null)localStorage.setItem(k,'dark');}}catch(e){}})();",
        },
        {
          tag: 'script',
          attrs: { type: 'module' },
          content:
            "import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs';mermaid.initialize({startOnLoad:true,theme:document.documentElement.dataset.theme==='light'?'default':'dark'});",
        },
      ],
      sidebar: [
        { label: 'Introduction', slug: 'index' },
        {
          label: 'Getting Started',
          items: [
            { label: 'Quick Start', slug: 'getting-started/quick-start' },
            { label: 'Deployment Guide', slug: 'getting-started/deployment-guide' },
          ],
        },
        {
          label: 'Using the Platform',
          items: [
            { slug: 'using/overview' },
            { slug: 'using/task-types' },
            { slug: 'using/authentication' },
            { slug: 'using/using-the-rest-api' },
            { slug: 'using/using-the-cli' },
            { slug: 'using/webhook-integration' },
            { slug: 'using/task-lifecycle' },
            { slug: 'using/what-the-agent-does' },
            { slug: 'using/tips-for-being-a-good-citizen' },
          ],
        },
        {
          label: 'Customizing',
          items: [
            { slug: 'customizing/repository-onboarding' },
            { slug: 'customizing/per-repo-overrides' },
            { label: 'Prompt Engineering', slug: 'customizing/prompt-engineering' },
          ],
        },
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
          label: 'Architecture',
          collapsed: true,
          items: [
            { slug: 'architecture/architecture' },
            { slug: 'architecture/orchestrator' },
            { slug: 'architecture/security' },
            { slug: 'architecture/deployment-roles' },
            { slug: 'architecture/memory' },
            { slug: 'architecture/api-contract' },
            { slug: 'architecture/compute' },
            { slug: 'architecture/input-gateway' },
            { slug: 'architecture/observability' },
            { slug: 'architecture/cost-model' },
            { slug: 'architecture/evaluation' },
            { slug: 'architecture/repo-onboarding' },
          ],
        },
        {
          label: 'Roadmap',
          autogenerate: { directory: 'roadmap' },
        },
      ],
    }),
  ],
});
