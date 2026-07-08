import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { remarkMermaid } from './plugins/remark-mermaid.mjs';
import remarkGfm from 'remark-gfm';

export default defineConfig({
  site: 'https://aws-samples.github.io',
  base: '/sample-autonomous-cloud-coding-agents',
  markdown: {
    remarkPlugins: [remarkMermaid, remarkGfm],
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
        Hero: './src/components/Hero.astro',
        Search: './src/components/Search.astro',
        SiteTitle: './src/components/SiteTitle.astro',
        Sidebar: './src/components/Sidebar.astro',
      },
      head: [
        {
          tag: 'script',
          content:
            "(function(){try{if(typeof localStorage!=='undefined'){var k='starlight-theme';if(localStorage.getItem(k)===null)localStorage.setItem(k,'light');}}catch(e){}})();",
        },
        {
          tag: 'script',
          attrs: { type: 'module' },
          content:
            "import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs';mermaid.initialize({startOnLoad:true,theme:document.documentElement.dataset.theme==='light'?'default':'dark'});",
        },
      ],
      sidebar: [
        { label: 'Home', slug: 'index' },
        { label: 'Introduction', slug: 'introduction/introduction' },
        {
          label: 'Getting Started',
          items: [
            { label: 'Quick Start', slug: 'getting-started/quick-start' },
            { label: 'Deployment Guide', slug: 'getting-started/deployment-guide' },
            { label: 'Cost Attribution', slug: 'getting-started/cost-attribution' },
            { label: 'Troubleshooting', slug: 'troubleshooting/troubleshooting' },
            { label: 'Learning path', slug: 'getting-started/learning-path' },
          ],
        },
        {
          label: 'Use Cases & Tutorials',
          items: [
            { label: 'All use cases', slug: 'use-cases/use-cases-index' },
            { slug: 'use-cases/implement-from-issue' },
            { slug: 'use-cases/automated-pr-review' },
            { slug: 'use-cases/web-research-brief' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'How the platform works', slug: 'concepts/how-the-platform-works' },
            {
              label: 'Level 100 — Fundamentals',
              collapsed: true,
              items: [
                { slug: 'concepts/level-100/task-and-workflow' },
                { slug: 'concepts/level-100/blueprint-vs-workflow' },
                { slug: 'concepts/level-100/orchestrator-and-agent' },
                { slug: 'concepts/level-100/agent-harness' },
              ],
            },
          ],
        },
        {
          label: 'Using the Platform',
          items: [
            { slug: 'using/overview' },
            { slug: 'using/roles' },
            { slug: 'using/workflows' },
            { slug: 'using/authentication' },
            { slug: 'using/using-the-rest-api' },
            { slug: 'using/using-the-cli' },
            { slug: 'using/webhook-integration' },
            { slug: 'using/slack-setup-guide' },
            { slug: 'using/linear-setup-guide' },
            { slug: 'using/linear-pak-migration-runbook' },
            { slug: 'using/jira-setup-guide' },
            { slug: 'using/deploy-preview-screenshots-guide' },
            { slug: 'using/approval-gates-cedar-hitl' },
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
            { label: 'Cedar Policies', slug: 'customizing/cedar-policies' },
          ],
        },
        {
          label: 'Developer Guide',
          items: [
            { slug: 'developer-guide/introduction' },
            { slug: 'developer-guide/where-to-make-changes' },
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
            { slug: 'architecture/vision' },
            { slug: 'architecture/workflows' },
            { slug: 'architecture/orchestrator' },
            { slug: 'architecture/security' },
            { slug: 'architecture/cedar-hitl-gates' },
            { slug: 'architecture/interactive-agents' },
            { slug: 'architecture/identity-and-auth' },
            { slug: 'architecture/deployment-roles' },
            { slug: 'architecture/memory' },
            { slug: 'architecture/api-contract' },
            { slug: 'architecture/compute' },
            { slug: 'architecture/input-gateway' },
            { slug: 'architecture/observability' },
            { slug: 'architecture/cost-model' },
            { slug: 'architecture/bedrock-cost-attribution' },
            { slug: 'architecture/evaluation' },
            { slug: 'architecture/attachments' },
            { slug: 'architecture/repo-onboarding' },
            { slug: 'architecture/docs-site-revamp' },
          ],
        },
        {
          label: 'Decisions',
          collapsed: true,
          items: [{ autogenerate: { directory: 'decisions' } }],
        },
      ],
    }),
  ],
});
