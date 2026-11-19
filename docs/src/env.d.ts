/// <reference types="astro/client" />

// Types of the Starlight virtual modules that the components in src/components import.
// Starlight shipped them in `virtual.d.ts` and `virtual-internal.d.ts` up to 0.41. From 0.42
// the package is compiled JavaScript and declares none of its virtual modules, although the
// modules still exist (`dist/integrations/vite-virtual-modules.js` in the package). These five
// declarations are the ones of 0.41.3, with its relative imports written as package paths.
// The modules are internal to Starlight: compare them with that file when Starlight is bumped.
// `astro check` does not check declaration files (`skipLibCheck`), so an import below that
// no longer resolves turns its type into `any` without an error.

declare module 'virtual:starlight/user-config' {
  const Config: import('@astrojs/starlight/types').StarlightConfig;
  export default Config;
}

declare module 'virtual:starlight/project-context' {
  const ProjectContext: {
    root: string;
    srcDir: string;
    trailingSlash: import('astro').AstroConfig['trailingSlash'];
    build: {
      format: import('astro').AstroConfig['build']['format'];
    };
  };
  export default ProjectContext;
}

declare module 'virtual:starlight/user-images' {
  type ImageMetadata = import('astro').ImageMetadata;
  export const logos: {
    dark?: ImageMetadata;
    light?: ImageMetadata;
  };
}

declare module 'virtual:starlight/pagefind-config' {
  export const pagefindUserConfig: Partial<
    Extract<import('@astrojs/starlight/types').StarlightConfig['pagefind'], object>
  >;
}

declare module 'virtual:starlight/components/MobileMenuFooter' {
  const MobileMenuFooter: typeof import('@astrojs/starlight/components/MobileMenuFooter.astro').default;
  export default MobileMenuFooter;
}
