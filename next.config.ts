import { execSync } from 'child_process';
import path from 'path';
import type { NextConfig } from "next";

const projectRoot = path.resolve(__dirname);

const commitHash = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'unknown';
  }
})();

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_COMMIT_HASH: commitHash,
  },
  output: 'standalone',
  outputFileTracingRoot: projectRoot,
  serverExternalPackages: ['better-sqlite3'],
  bundlePagesRouterDependencies: true,
  outputFileTracingExcludes: {
    '*': [
      './release/**',
      './CLAUDE.md',
      './AGENTS.md',
      './README*.md',
      './docs/**',
      './.specs/**',
      './.claude/**',
      './tests/**',
    ],
  },
  outputFileTracingIncludes: {
    '/api/mission-control/**/*': ['./node_modules/better-sqlite3/**/*'],
    '/api/cli/mission-control/**/*': ['./node_modules/better-sqlite3/**/*'],
  },
  reactStrictMode: true,
  experimental: {
    optimizePackageImports: ['react-icons'],
  },
  turbopack: {
    root: projectRoot,
  },
  i18n: {
    locales: ['en', 'ko', 'ja', 'zh-CN', 'es', 'de', 'fr', 'pt-BR', 'zh-TW', 'ru', 'tr'],
    defaultLocale: 'en',
    localeDetection: false,
  },
  headers: async () => [
    {
      source: '/fonts/:path*',
      headers: [
        {
          key: 'Cache-Control',
          value: 'public, max-age=31536000, immutable',
        },
      ],
    },
  ],
};

export default nextConfig;
