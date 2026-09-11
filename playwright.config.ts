import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './test/browser', timeout: 40_000, workers: 1, use: { headless: true }, reporter: 'list' });
