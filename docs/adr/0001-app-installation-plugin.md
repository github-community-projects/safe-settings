# 1. App installation management plugin

- Status: Accepted
- Date: 2026-07-06
- Last updated: 2026-07-08 — documented the repo-centric → app-centric shift and
  the delta/full-sync model, and made reconciliation 422-safe (additions before
  removals in both paths, with an explicit error when a `selected` installation
  would be reduced to zero repositories). Earlier (2026-07-07): reporting subject
  model, per-repo pipeline exclusion, startup verification, non-managed-app
  safety guarantee, smoke tests, and removal of the redundant
  `repository_selection` config attribute (org level is implicitly "all").
- Deciders: safe-settings maintainers
- Related PR: `decyjphr-app-installation-plugin`

## Context

Safe-settings manages configuration whose **target is a repository** (branch
protection, labels, collaborators, …), with a couple of exceptions
(`rulesets`, `custom_repository_roles`) that target the organization. All of
these are driven through the org → suborg → repo configuration hierarchy and
applied by `syncAll` / `syncSelectedRepos` / `sync`.

We need a new capability where the **target of the operation is a GitHub App
installation** rather than a repository. Concretely, safe-settings should
declaratively control **which repositories each installed GitHub App can
access** (the installation's repository access), driven by the same config
hierarchy:

- **Org-level `settings.yml`** → the app should have access to **all** repos in
  the org.
- **Suborg-level `suborgs/*.yml`** → repos selected by the suborg's targeting
  criteria (custom properties, teams, names).
- **Repo-level `repos/*.yml`** → the specific repo, by name.

Two hard constraints shaped the design:

1. **A different credential is required.** Reading org/suborg/repo config and
   resolving repos can use the normal per-installation Octokit client. But
   **mutating an app's installation repository access** requires an Octokit
   client authenticated as the App at the **enterprise** level, using the
   [Enterprise Organization Installations API][ent-api] (permission:
   *Enterprise organization installations*).
2. **Drift.** Humans can change an app's repo access outside safe-settings, so
   we want to detect and revert that drift.

We also want the design to accommodate **future non-repo targets** (e.g.,
Copilot policies) without another ground-up rewrite.

## Decision

Add an `app_installations` plugin plus supporting infrastructure, wired into
the existing sync pipeline as a **separate phase**.

This capability shifts safe-settings from a purely **repo-centric** model toward
a more general one. Until now, a trigger — a change to `settings.yml`, a
`suborgs/*.yml`, or a `repos/*.yml` — caused `syncAll` or `syncSelectedRepos` to
resolve a **collection of repositories** and invoke each plugin against them.
App installation management inverts part of that flow: a change still resolves a
collection of repositories, but it **also** resolves a **collection of
applications**, which are then processed iteratively. For each application the
plugin computes the set of repositories that should constitute its
`repository_selection`.

The subtlety is that a single `repos/*.yml` change surfaces only **one**
repository in the changed set, whereas an app's desired access is the **union of
every** repository that currently targets it — conceptually `existing + new`.
Removal is harder still: to know which repositories an app should *lose*, we must
compare against the repositories derived from the **previous commit** on the
default branch. We call the process of computing these per-app additions and
deletions from a config change **delta sync**; a complementary **full sync**
recomputes each app's complete desired state from scratch to reconcile
configuration drift. Both are detailed under *Sync model* below.

### Configuration shape

```yaml
# settings.yml (org level) — implies "all repos"
app_installations:
  - app_slug: ghas-compliance-decyjphr-emu
  - app_slug: migrator-destination-dotcom

# suborgs/team-a.yml — repos selected by this suborg's criteria
app_installations:
  - app_slug: migrator-destination-dotcom

# repos/my-repo.yml — this specific repo
app_installations:
  - app_slug: migrator-destination-dotcom
```

### Components

| Component | Responsibility |
| --- | --- |
| `lib/plugins/appInstallations.js` | Reconcile desired vs. live repo access per app (`syncDelta` / `syncFull`). Not `Diffable` — app installations are an org-scoped target, not a per-repo list. |
| `lib/appOctokitClient.js` | Enterprise-level App client for the Enterprise Organization Installations API. |
| `lib/repoSelector.js` | Resolve a repo set from **fixed** criteria: name, team, custom properties, or "all". |
| `lib/settings.js` | `syncAppInstallations` phase; delta computation from changed configs; full desired-state computation; app-aware NOP reporting. |
| `lib/nopcommand.js` | Carries an optional `subject` / `subjectType` so reporting can render the **app** (not the org placeholder repo) as the subject of a change. |
| `index.js` | Enterprise-client enrichment on the context (`getEnterpriseAppClient`); `installation_target` webhook handler; startup `verifyAppInstallationsPlugin` diagnostic. |

### Sync model: delta vs. full

- **Delta (`syncSelectedRepos`, push events)**: only apps that appear in
  **changed** config files are "marked for change". For each changed
  suborg/repo file we compute, per app:
  - `repository_selection` — repos to **add**,
  - `repository_unselection` — repos to **remove** (by diffing the previous
    `baseRef` version of *that one file* — one extra fetch, reusing the existing
    "removed from suborg targeting" pattern).

  Apps configured with org-level "all" are **not** handled in delta mode; they
  are managed only by full sync.

- **Full (`syncAll`, cron/manual)**: recompute the complete desired state for
  every managed app across all config layers and reconcile against live API
  state. This is the only place the expensive full computation runs, and the
  only path that reconciles drift.

### Enterprise API usage

All mutations go through the org-scoped Enterprise Organization Installations
API (version `2026-03-10`) and operate on repository **names**:

- List installations: `GET /enterprises/{ent}/apps/organizations/{org}/installations`
- List repos: `GET …/installations/{id}/repositories`
- Toggle all/selected: `PATCH …/installations/{id}/repositories`
- Add: `PATCH …/installations/{id}/repositories/add`
- Remove: `PATCH …/installations/{id}/repositories/remove`

Add/remove are capped at **50 repos per call** and are auto-batched.

### Reporting (NOP / PR check-run)

The rest of safe-settings reports changes **per repository**. App installation
changes have no meaningful repository subject — the NopCommands are emitted
against the `<org> (org)` placeholder repo, which rendered confusingly (e.g. a
`**admin**` heading with a nested `value: (all repositories)` row).

To fix this without a disruptive rename of the repo-centric reporting pipeline,
`NopCommand` gained an **optional, additive `subject` / `subjectType`**:

- `subject` defaults to the repo, so every existing plugin is unaffected.
- `app_installations` sets `subject = <app_slug>`, `subjectType = 'app'`.
- Reporting groups changes by `subject` (identical to the repo for all other
  plugins), so each **app** becomes its own heading.
- For `app_installations`, the impact summary pluralizes **apps** (not repos),
  rows render as a flat `+`/`-` list of repositories, and the section is
  excluded from the "repos affected" count (app subjects must not inflate it).
- The `NopCommand` constructor accepts the `subject` object in the `type`
  position (defaulting `type` to `INFO`) so callers can pass a subject without
  restating the default type.

## Decisions and rationale

1. **Enterprise auth is a prerequisite, not a config knob.**
   safe-settings must already be installed on the enterprise with the
   *Enterprise organization installations* permission. If it is not, the plugin
   surfaces a clear error rather than accepting a separate private-key env var.
   The enterprise slug is read from the webhook payload
   (`payload.enterprise.slug`); the enterprise installation id is discovered via
   `apps.listInstallations` (matching `target_type === 'Enterprise'` &&
   `account.slug === enterprise.slug`) and cached for reuse.

2. **App installation sync is a separate phase**, not folded into `updateOrg()`.
   This keeps repo iteration and app reconciliation independent and easier to
   reason about and disable.

3. **Fixed repo-selection criteria only** (name, team, custom properties, plus
   "all"). No arbitrary Search API queries, to keep behavior predictable and
   reuse existing `getReposForTeam` / `getRepositoriesByProperty` patterns.

4. **Org-level "all" takes precedence** over any suborg/repo-level selection or
   exclusion. An org-level `app_installations` entry lists only the `app_slug`
   — it always implies **all** repos (there is no `repository_selection` config
   attribute; it was removed as redundant). When an app is named at the org
   level, the installation is toggled to `all` and deltas for that app are
   skipped.

5. **Repository NAMES, not IDs.** The Enterprise Org Installations API accepts
   names, so the plugin no longer resolves names → IDs or enumerates all repos
   for the "all" case (it uses the native toggle instead).

6. **Additions before removals (both delta and full sync).** The add/remove
   sets are always disjoint before they are applied: in **delta** mode
   `_buildAppChangesFromDelta` drops any repo appearing in both selection and
   unselection (selection wins), and in **full sync** they are disjoint by
   construction (`toAdd = desired − live`, `toRemove = live − desired`). Because
   the sets are disjoint, ordering does not change the final repo set — so
   additions are applied **first** in both paths. Adding first prevents a
   "swap" (e.g. live `{A}` → desired `{B}`) from momentarily dropping a
   `selected` installation to zero repositories, which the Enterprise API
   rejects with `422`.

   A `selected` installation must retain at least one repository, so a change
   that would drive one to **zero** is surfaced as an error rather than
   attempted — but *only* when it would actually strip access while
   safe-settings is managing it. Concretely, an empty desired/required repo set
   is **not** universally an error:
   - **Full sync, non-additive, installation would lose all repos** (currently
     `all` and asked to narrow to none, or currently `selected` with live repos
     and desired resolves to none) → **error**; the installation is left
     unchanged. Full sync knows the complete desired set, so it detects this
     up-front.
   - **Additive mode** → never an error: additive never narrows or removes, so
     an empty desired set simply adds nothing.
   - **Nothing to reconcile** (installation already has no relevant repos) →
     no-op, no error.
   - **Org-level `all`** → not applicable; the app is toggled to `all` and the
     empty case never arises.
   - **Delta mode** → an empty incremental change is a no-op. Delta does not
     fetch live state, so it cannot know up-front that a removal would empty the
     installation; it instead catches the `422` on removal, emits a descriptive
     error, and defers the correct end state to the next full sync.


7. **Churn skip.** In delta mode, if an app's targeting is unchanged between the
   previous and current versions of a file, it is skipped entirely to avoid
   redundant add/remove writes.

8. **Full-sync `current_selection` awareness.** Full sync reads each
   installation's live `repository_selection` and chooses the minimal action:
   skip when already correct; toggle `all` ↔ `selected`; or diff names and
   add-then-remove when already `selected` (see decision #6). In `additive` mode
   it never narrows an `all` installation.

9. **`disable_plugins` / `additive_plugins` support.** `app_installations`
   participates in the same gating: it can be disabled at any layer, and in
   additive mode it only adds, never removes.

10. **Future target abstraction.** The plugin is structured around a target that
    is *not* a repository, paving the way for future targets (e.g., Copilot
    policies) to reuse the same phase/plumbing without being repo-bound.

11. **`app_installations` is excluded from the per-repo plugin pipeline.**
    Although it is registered in `Settings.PLUGINS` (so `disable_plugins` /
    `additive_plugins` name-validation and suborg-cleanup detection recognize
    it), `childPluginsList` explicitly skips it. The per-repo pipeline calls
    `instance.sync()`, which `AppInstallations` does not implement (it exposes
    `syncDelta` / `syncFull` and has a different constructor signature). It is
    reconciled **only** through the dedicated `syncAppInstallations` phase.

12. **App is the reporting subject.** See *Reporting* above — an additive
    `NopCommand.subject` avoids a global rename of the repo-centric pipeline
    while presenting app installation changes with the app as the subject and
    keeping repo counts accurate.

13. **Startup verification.** On boot, `index.js` runs
    `verifyAppInstallationsPlugin`: when `GH_ENTERPRISE` is set it mints an
    enterprise installation token and confirms it can list app installations in
    the target org (`GH_ORG`), logging a clear success/failure. When
    `GH_ENTERPRISE` is unset the check is skipped, so non-enterprise
    deployments are unaffected. This surfaces a mis-scoped enterprise install
    early rather than at first sync.

14. **Only explicitly-named apps are ever touched.** Both full and delta sync
    operate solely on apps that appear in an `app_installations` entry in some
    config layer. `listOrgInstallations` is used only to resolve
    `app_slug → installation_id`; it never seeds the desired state, and there is
    no "remove apps not in config" sweep. Consequently the safe-settings app's
    own installation (and every other unlisted app) is left untouched on every
    sync unless a config explicitly names it.

## Consequences

### Positive

- App access is now declarative and flows through the existing config hierarchy.
- Delta processing keeps incremental (push-triggered) runs cheap.
- Names-based API + native "all" toggle removes an entire class of ID-resolution
  and enumeration work.
- Batching respects the 50-repo API limit transparently.
- App installation changes read clearly in PR comments (app as subject) without
  reworking the repo-centric reporting pipeline or distorting repo counts.
- Unlisted apps — including safe-settings itself — are provably never modified,
  so enabling the plugin cannot accidentally lock the app out of repositories.
- A startup self-check catches missing/mis-scoped enterprise permissions before
  the first sync.
- Smoke coverage (`smoke-test.js` Phase 17) exercises org-level `all`,
  repo-level selection, add/remove, drift remediation via full sync, and
  sub-org (delta) targeting, restoring each app's original state on teardown.

### Negative / limitations

- **Managed-app drift relies on the scheduled full sync.** An app only receives
  `installation` repository events for its *own* installation, so there is no
  webhook that reports drift on *other* managed apps. The
  `installation.repositories_added/removed` handler was intentionally **removed**
  because it could not detect managed-app drift; only `installation_target` is
  retained. Drift on managed apps is reconciled on the next cron full sync.
- **Multi-suborg overlap** in delta mode is handled by de-duplicating the
  selection/unselection sets (selection wins) and applying additions before
  removals, so the net end state is correct and a `selected` installation is
  never momentarily emptied. A removal that would still drop the installation to
  zero repos (which delta cannot detect without a live-state fetch) is caught as
  a `422`, reported, and reconciled by the next full sync.
- Requires an enterprise-level installation with the specific permission; orgs
  not on enterprise cannot use the plugin.

## Alternatives considered

- **Enumerate all repos and add them individually for the "all" case** —
  rejected in favor of the API's native `repository_selection: all` toggle
  (fewer calls, no drift from newly created repos).
- **Arbitrary Search API queries for repo selection** — rejected for now in
  favor of a fixed, predictable criteria set.
- **Suborg exclusions overriding org "all"** — rejected; org "all" takes
  precedence to keep the mental model simple.
- **A dedicated private-key env var for enterprise auth** — rejected in favor of
  reusing the existing app credentials and treating enterprise installation as a
  prerequisite.

[ent-api]: https://docs.github.com/en/enterprise-cloud@latest/rest/enterprise-admin/organization-installations?apiVersion=2026-03-10
