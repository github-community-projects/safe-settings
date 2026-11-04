# Github Safe-Settings HubSync Usecases

This page lists what happens when you change the Hub repo, as **Given / When / Then** cases. Paths are relative to the Hub folder (`<CONFIG_PATH>/<SAFE_SETTINGS_HUB_PATH>/`, for example `.github/safe-settings/`). The spoke is `<org>/<ADMIN_REPO>`, and files land under `CONFIG_PATH` (for example `.github/`).

Every sync is triggered by a Hub PR that is **merged into the Hub repo's default branch**. Before the merge, the Hub PR check (section F) validates the PR.

**Smoke test** column: whether the case can be automated in [`smoke-test-hub-sync.js`](../../smoke-test-hub-sync.js).

- **Yes**: it only touches the sandbox target org.
- **Partial**: needs extra setup, or only part of it can be verified.
- **No**: it changes other orgs, or needs an app restart or a different environment. Cover these with unit tests or manual tests.

Automated today (`HUB_SMOKE_TARGET_ORG=<sandbox-org> node smoke-test-hub-sync.js [--phase N,...]`):

| Phase | Cases |
|-------|-------|
| 1 | H1 |
| 2 | F2, E2 |
| 3 | A1, A2, A4, A5, C1, C3–C8, F1, F3 |
| 4 | C2, F3 |
| 5 | E3 |
| 6 | H2 (skipped when the app runs with `SAFE_SETTINGS_HUB_REIMPORT=true`) |

Known gaps in the current implementation are marked ⚠️.

---

## A. Organization sync (`organizations/<org>/`)

| ID | Given | When | Then | Smoke test |
|----|-------|------|------|------------|
| A1 | `organizations/<org>/settings.yml` exists in the Hub | A Hub PR that changes it is merged | `<org>/<ADMIN_REPO>` gets a sync PR (`safe-settings-sync/pr-<n>-<org>-<ts>`). Its `settings.yml` is **generated** by merging `globals/settings.yml` with the org file, with org values winning (see section C). | Yes |
| A2 | A non-settings file, such as `organizations/<org>/repos/my-repo.yml` or `suborgs/team.yml` | A Hub PR that adds or changes it is merged | The file is copied **as is** (no merge) to the same relative path under `CONFIG_PATH` in the spoke. | Yes |
| A3 | A Hub PR changes files for several orgs | It is merged | Each org gets its **own** sync PR, containing only its own files. | Partial (needs a second sandbox org) |
| A4 | A file sits directly in `organizations/`, not in an org subfolder | A Hub PR that changes it is merged | Nothing is synced. | Yes |
| A5 | A Hub PR changes both the org's `settings.yml` and other files | It is merged | One sync PR contains the merged `settings.yml` and the copied files. | Yes |

## B. Globals sync (`globals/`)

| ID | Given | When | Then | Smoke test |
|----|-------|------|------|------------|
| B1 | `globals/settings.yml` exists | A Hub PR that changes it is merged | Every org that has an `organizations/<org>/` folder **and** matches the manifest `targets` gets a sync PR (`safe-settings-sync/globals-<ts>`) with a regenerated, merged `settings.yml`. | No (changes every targeted org) |
| B2 | An org matches the manifest but has **no** `organizations/<org>/` folder | `globals/settings.yml` changes | That org does **not** receive `settings.yml`. The org list for `settings.yml` comes from the `organizations/` folders. | No (changes every targeted org) |
| B3 | Another globals file exists, such as `globals/suborgs/x.yml` | A Hub PR that changes it is merged | The file is copied to **every org where the app is installed** that matches the manifest and has `ADMIN_REPO`. | No (changes every targeted org) |
| B4 | `globals/manifest.yml` changes | The Hub PR is merged | `manifest.yml` is never synced; it exists only in the Hub. | No (changes Hub sync behavior for all orgs) |

## C. `settings.yml` merge behavior (globals + organization)

These cases are triggered through the org file (A1), so they only affect the sandbox org.

| ID | Given | When | Then | Smoke test |
|----|-------|------|------|------------|
| C1 | Globals and the org file both define `repository` with different values | The org file is synced | The org's values win for overlapping keys, and keys that only globals sets are kept. | Yes |
| C2 | Globals defines `branches`, and the org file used to as well | `branches` is **deleted** from the org file | The org **still inherits** `branches` from globals. The Hub PR check warns: "`branches` was removed … but `globals/settings.yml` still defines it". | Yes |
| C3 | Globals defines `branches` | The org file sets `branches: null` | `branches` is left out of the spoke `settings.yml`, and the header lists it under "Not inherited from globals". The Hub PR check lists it under **ℹ️ Inheritance Overrides**. Existing branch protection on GitHub is **not** deleted. | Yes |
| C4 | Globals defines `branches` | The org file sets `branches: []` | This does **not** opt out. Lists are merged, so the globals entries stay. | Yes |
| C5 | The org file has a branch entry with `protection: null` | It is synced | The nested `null` is **kept**, so Safe-Settings removes that branch's protection. | Yes |
| C6 | Globals and the org file both define a list entry with the same identity (for example label `bug`, ruleset `main-protect`, or collaborator `octocat`) | The org file is synced | One merged entry, with the org's values winning, and **no duplicate**. Nested lists inside the entry are merged the same way. | Yes |
| C7 | The org file repeats a globals list entry exactly | It is synced | No duplicate is added. | Yes |
| C8 | The org file adds a new list entry, such as a label `docs` | It is synced | The entry is added next to the globals entries. | Yes |
| C9 | No `organizations/<org>/settings.yml` exists | `globals/settings.yml` changes | The org is skipped for `settings.yml`. This is the same as B2. | No |

List identity fields, in order: `name`, `username`, `login`, `title`, `key_prefix`, `context`, then `actor_type` with `actor_id`, `type` with `id`, and finally `type`.

## D. Manifest control (`globals/manifest.yml`)

| ID | Given | When | Then | Smoke test |
|----|-------|------|------|------------|
| D1 | The manifest `targets` do **not** match the org | An org file changes | The org is not synced. The Hub PR check lists it as excluded. | Partial (check only, on an unmerged PR) |
| D2 | The manifest `files` patterns do not match a changed file | The Hub PR is merged | That file is skipped. The Hub PR check lists it as excluded. | Partial (check only, on an unmerged PR) |
| D3 | A rule has `enabled: false` | The rule would otherwise match | The rule is ignored. | Partial (check only, on an unmerged PR) |
| D4 | Wildcard targets (`"*"`, `"acme-*"`) | An org name matches | The org is included. | Partial (check only, on an unmerged PR) |

## E. Delivery and triggers

| ID | Given | When | Then | Smoke test |
|----|-------|------|------|------------|
| E1 | `SAFE_SETTINGS_HUB_DIRECT_PUSH=true` | A Hub PR is merged | Changes are committed straight to the spoke's `main` and no sync PR is opened. | No (needs an app restart with a different env) |
| E2 | A Hub PR is **closed without merging** | — | Nothing is synced. | Yes |
| E3 | A Hub PR is merged into a branch that is **not** the default branch | — | Nothing is synced. | Yes |
| E4 | A merged PR in a repo that is **not** the configured Hub repo | — | Hub-Sync ignores it. | No |

## F. Hub PR check (before merge)

| ID | Given | When | Then | Smoke test |
|----|-------|------|------|------------|
| F1 | A Hub PR changes files under `globals/` or `organizations/` | The PR is opened or updated | A check run completes with a summary of the target orgs, files, warnings and inheritance overrides. The summary is also posted as a PR comment. | Yes |
| F2 | A changed file contains **invalid YAML** | The PR is opened or updated | The check concludes **failure**. | Yes |
| F3 | Only warnings, such as C2 or excluded orgs or files | The PR is opened or updated | The check concludes **success**, with the warnings listed. | Yes |

## G. Failure and edge cases

| ID | Given | When | Then | Smoke test |
|----|-------|------|------|------------|
| G1 | The app is **not installed** on the target org | A sync is triggered | The org is skipped with a log message, and the other orgs still sync. The smoke test checks this before setup. | No (pre-flight only) |
| G2 | The target org has **no `ADMIN_REPO`** | A globals sync is triggered | The org is skipped (`config repo '<ADMIN_REPO>' does not exist`). | Partial |
| G3 | ⚠️ A file is **deleted** under `organizations/<org>/` | The Hub PR is merged | The spoke copy is **not** deleted. Reading the removed file fails, so that org's sync stops, which can leave an empty sync branch behind. Expected: the deletion is synced, or the file is skipped. | Yes (documents the gap) |
| G4 | The spoke repo's default branch is **not `main`** (for example `master`) | A sync or import is triggered | Hub-Sync looks up the repo's default branch: sync branches and PRs are based on it, direct pushes go to it, and the import reads from it. Import PRs into the Hub target the Hub repo's default branch. | Partial (sandbox repo with a different default branch) |
| G5 | The org's `settings.yml` in the Hub has invalid YAML and the PR was merged anyway | A sync is triggered | The merge fails and that org is not synced. The F2 check is meant to prevent this. | No |

## H. Import (spoke → Hub)

Triggered with `POST /api/safe-settings/hub/import`, or from the dashboard.

| ID | Given | When | Then | Smoke test |
|----|-------|------|------|------------|
| H1 | The org has `<ADMIN_REPO>` with files under `CONFIG_PATH`, and the Hub has no `organizations/<org>/` | Import is run | A Hub PR copies the org's config into `organizations/<org>/`. | Yes (through the API) |
| H2 | The org was already imported, and `SAFE_SETTINGS_HUB_REIMPORT=false` (the default) | Import is run again | The org is skipped (`already_imported`). | Yes (through the API) |
| H3 | `SAFE_SETTINGS_HUB_REIMPORT=true` | Import is run again | The Hub files are updated through a PR, or `no_changes` is returned if they're identical. | No (needs an app restart with a different env) |
| H4 | The org has no `ADMIN_REPO`, or no files at `CONFIG_PATH` | Import is run | The result is `N/A` (`admin_repo_not_found` or `no_files_at_config_path`). | Partial |

