import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // spike/ holds standalone behaviour-check scripts ("7/7 SDK checks pass"
    // harnesses) run directly during development — they are not vitest
    // suites, so exclude them from the test run.
    // central/ is a standalone npm package with its own vitest config and
    // singleFork=true to serialize port-binding tests. Running it from the
    // top-level breaks that serialization (workers race for 18200+). Each
    // package owns its own test run.
    exclude: ['**/node_modules/**', '**/dist/**', 'spike/**', 'central/**'],
    server: {
      deps: {
        external: ['undici'],
      },
    },
  },
});
