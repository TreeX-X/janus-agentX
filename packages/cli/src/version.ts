/**
 * @file Single source of truth for the CLI version string.
 * @description Must stay in sync with `packages/cli/package.json` `version`.
 * `scripts/pack-cli.mjs` asserts the equality and fails the pack otherwise,
 * so `janus version` can never drift from the published package version.
 */
export const CLI_VERSION = '0.1.0'
