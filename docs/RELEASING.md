# Publish an update

The canonical source repository is `TheMakerOfWorlds/chatgpt-chrome-bridge`. Clients install **stable GitHub Releases**, not arbitrary branch snapshots. The repository can be public or private; public access is needed before uninvited people can install it. Never include runtime profiles, cookies, `.env` files, personal verification output, or account-specific project URLs in a release.

1. Make and review the change. Update `package.json`, the root package version in `package-lock.json`, and the base version in `.codex-plugin/plugin.json` to the same new semantic version, such as `0.2.3`. Keep release versions unique; never replace the contents of an existing version.
2. Run `npm ci`, `npm run check`, `npm test`, and `npm run release:build`. Run a live account check when browser behavior changes. Commit the change and push it to GitHub.
3. Tag that commit and push the tag:

   ```sh
   git tag v0.2.3
   git push origin main v0.2.3
   ```

4. The **Release** GitHub Actions workflow runs tests, validates that the tag matches the package version, builds an explicit allowlist of release files, and publishes `release.json` plus `bridge.bundle.json.gz`. Check that the workflow and GitHub release completed successfully.
5. On a test Mac, run the installed maintenance command's `update`, then `login` to verify account access. Other computers with automatic updates enabled will check within six hours of bridge use. New Codex tasks load the new version; active tasks are not restarted.

Local plugin development may use the plugin-creator skill's timestamp cachebuster. Release comparison uses the stable package version; the manifest retains the exact plugin version so Codex receives a new cache entry. A numeric version increase is required to distribute a new stable release.

The builder omits `.git`, installed dependencies, logs, runtime data, archives, and personal live-test helpers. Its compressed JSON bundle contains regular text files only. The installer validates file paths and sizes rather than extracting arbitrary tar entries. The checksum detects corrupt or substituted asset contents relative to the release manifest; GitHub repository access remains the publisher trust boundary. Dependencies are pinned by package-lock and installed with lifecycle scripts disabled.

For a local rehearsal, build the assets and run:

```sh
sh install.sh --from-bundle dist/bridge.bundle.json.gz --manifest dist/release.json --skip-login
```

This installs a managed release and registers it in Codex. Use a temporary `CHATGPT_CHROME_BRIDGE_STATE_DIR` and isolated Codex test configuration for tests that should not change your real installation.

Rollback: run the maintenance command's `rollback`; this disables auto-updates so it stays rolled back. To repair a bad public release, publish a higher fixed version; do not rewrite an already installed release. Re-enable updates with `auto-on` when ready.
