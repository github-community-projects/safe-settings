# Running Safe-settings with GitHub Actions (GHA)

This guide describes how to schedule a full safe-settings sync using GitHub Actions. This assumes that an `admin` repository has been configured with your `safe-settings` configuration. Refer to the [How to Use](../README.md#how-to-use) docs for more details on that process.


## GitHub App Creation
Follow the [Create the GitHub App](deploy.md#create-the-github-app) guide to create an App in your GitHub account. This will allow `safe-settings` to access and modify your repos.


## Defining the GitHub Action Workflow
Running a full-sync with `safe-settings` can be done via `npm run full-sync`. This requires installing Node, such as with [actions/setup-node](https://github.com/actions/setup-node) (see example below). When doing so, the appropriate environment variables must be set (see the [Environment variables](#environment-variables) document for more details).

Manual and scheduled (`CRON`) full syncs process every repository-owning App
installation sequentially, using each installation's token and account login for
its admin repository. Enterprise installations are not repository sync targets;
they remain available for enterprise app-management context enrichment.
An authentication, configuration, or sync failure does not stop later installations.
The returned `{ results, errors }` retains each returned Settings result (including
partial results) and aggregates their errors with thrown and missing-result failures.
An info-level summary counts installations with errors as failed. `FULL_SYNC_NOP=true`
previews every installation and still reports failures with a nonzero CLI exit.
No eligible installations returns `null` from `syncInstallation` and exits the CLI
nonzero with an explicit diagnostic.

`GH_ORG` does not restrict this full-sync path. Do not use a multi-installation App
for a live single-organization test by setting `GH_ORG` alone; the smoke test's
Phase 22 uses a controlled installation list and auth boundary instead.

Installation repositories are processed in batches of up to ten, with each batch
settling before the next starts. A repository failure does not stop later
repositories from being processed. Failures are logged with the repository name
and retained in the sync errors, so a partial failure still produces a failed
check and a nonzero full-sync exit status. Dry runs report these errors alongside
planned changes. The same batching applies when scanning installation repositories
for suborg configuration changes; existing repository restrictions still apply.


### Example GHA Workflow
The below example uses the GHA "cron" feature to run a full-sync every 4 hours. While not required, this example uses the `.github` repo as the `admin` repo (set via `ADMIN_REPO` env var) and the safe-settings configurations are stored in the `safe-settings/` directory (set via `CONFIG_PATH` and `DEPLOYMENT_CONFIG_FILE`).

```yaml
name: Safe Settings Sync
on:
  schedule:
    - cron: "0 */4 * * *"
  workflow_dispatch: {}

jobs:
  safeSettingsSync:
    runs-on: ubuntu-latest
    env:
      # Version/tag of github/safe-settings repo to use:
      SAFE_SETTINGS_VERSION: 2.1.17

      # Path on GHA runner box where safe-settings code downloaded to:
      SAFE_SETTINGS_CODE_DIR: ${{ github.workspace }}/.safe-settings-code
    steps:
      # Self-checkout of 'admin' repo for access to safe-settings config:
      - uses: actions/checkout@v4

      # Checkout of safe-settings repo for running full sync:
      - uses: actions/checkout@v4
        with:
          repository: github/safe-settings
          ref: ${{ env.SAFE_SETTINGS_VERSION }}
          path: ${{ env.SAFE_SETTINGS_CODE_DIR }}
      - uses: actions/setup-node@v4
      - run: npm install
        working-directory: ${{ env.SAFE_SETTINGS_CODE_DIR }}
      - run: npm run full-sync
        working-directory: ${{ env.SAFE_SETTINGS_CODE_DIR }}
        env:
          GH_ORG: ${{ vars.SAFE_SETTINGS_GH_ORG }}
          APP_ID: ${{ vars.SAFE_SETTINGS_APP_ID }}
          PRIVATE_KEY: ${{ secrets.SAFE_SETTINGS_PRIVATE_KEY }}
          GITHUB_CLIENT_ID: ${{ vars.SAFE_SETTINGS_GITHUB_CLIENT_ID }}
          GITHUB_CLIENT_SECRET: ${{ secrets.SAFE_SETTINGS_GITHUB_CLIENT_SECRET }}
          ADMIN_REPO: .github
          CONFIG_PATH: safe-settings
          DEPLOYMENT_CONFIG_FILE: ${{ github.workspace }}/safe-settings/deployment-settings.yml
```
