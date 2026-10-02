---
title: Safe Settings dry runs
description: How Safe Settings validates proposed configuration against live GitHub state without applying target settings
ms.date: 2026-09-03
ms.topic: concept
keywords:
  - safe settings
  - dry run
  - configuration validation
  - GitHub
estimated_reading_time: 5
---

## Overview

A Safe Settings dry run compares proposed YAML configuration with the current
state of live GitHub repositories and organizations. It uses GitHub API reads to
calculate the settings that would be added, modified, or removed.

A pull request dry run does not read uncommitted YAML from a local checkout. It
reads configuration committed and pushed to the pull request branch in the
admin repository. The local deployment configuration on the Safe Settings host
is also merged into the effective configuration.

> [!IMPORTANT]
> Dry-run mode prevents built-in plugins from changing target repository and
> organization settings. Safe Settings still creates or updates a check run and
> can add pull request comments to report the results.

## Pull request dry-run flow

When a pull request is opened or reopened against the configured admin
repository, Safe Settings performs the following actions:

1. Creates a `Safe-setting validator` check run.
2. Identifies changed global, suborganization, and repository configuration
   files.
3. Loads the proposed configuration from the pull request branch.
4. Loads the existing configuration from the base branch.
5. Retrieves current settings from affected live GitHub repositories or the
   organization.
6. Applies configuration merging and custom validation rules.
7. Calculates the additions, modifications, and deletions that would be needed.
8. Reports the results through the check run and, when enabled, pull request
   comments.

The check-run orchestration is implemented in
[`index.js`](../index.js#L639-L700).

## Configuration sources

Safe Settings assembles the effective configuration from these sources:

* The application deployment configuration, normally
  `deployment-settings.yml`, on the Safe Settings host
* Global settings in the admin repository
* Suborganization settings in the admin repository
* Per-repository override settings in the admin repository

Repository configuration files are loaded through the GitHub Contents API at a
specific Git ref. See
[`lib/configManager.js`](../lib/configManager.js#L16-L61).

For a pull request dry run, Safe Settings loads both the pull request branch and
the base branch. The base configuration allows the result processor to exclude
pre-existing drift that the pull request did not introduce. See
[`index.js`](../index.js#L34-L44) and
[`lib/settings.js`](../lib/settings.js#L936-L993).

### Local configuration behavior

The term "local configuration" can refer to two different sources:

| Configuration source | Included in a pull request dry run |
|----------------------|------------------------------------|
| YAML committed and pushed to the pull request branch | Yes |
| Uncommitted YAML in a developer checkout | No |
| Host-level `deployment-settings.yml` | Yes |

## Live GitHub comparison

Dry-run plugins retrieve the existing GitHub state before calculating a diff.
Depending on the configured plugins, the reads can include:

* Repository settings
* Labels
* Collaborators and teams
* Branch protection
* Repository and organization rulesets
* Autolinks
* Actions variables and environments
* Custom properties
* Custom repository roles

The shared diff process calls each plugin's `find()` implementation, compares
the returned live records with the desired configuration, and records the
result. See
[`lib/plugins/diffable.js`](../lib/plugins/diffable.js#L76-L165).

A dry run therefore performs more than YAML syntax validation. It previews the
reconciliation of the effective configuration against current GitHub state.

## Mutation suppression

Built-in plugins receive the `nop` flag during a dry run. Instead of executing
their normal add, update, or remove operations, they return `NopCommand`
records that describe the proposed work.

A `NopCommand` can contain:

* The plugin name
* The target repository
* The API endpoint, when available
* The proposed request body, when available
* The calculated additions, modifications, and deletions

The record is defined in
[`lib/nopcommand.js`](../lib/nopcommand.js#L1-L21). The shared plugin behavior
is implemented in
[`lib/plugins/diffable.js`](../lib/plugins/diffable.js#L97-L165).

Dry-run mode does not make the entire application read-only. Safe Settings must
still write its operational results by creating or updating the check run and,
when `CREATE_PR_COMMENT` is `true`, adding comments to the pull request. See
[`lib/settings.js`](../lib/settings.js#L1048-L1143).

## Validation behavior

Safe Settings supports two types of custom policy validators.

### Configuration validators

A `configvalidators` entry validates a setting on its own. For example, it can
prevent collaborators from receiving administrator permission.

### Override validators

An `overridevalidators` entry determines whether a narrower configuration may
override a broader setting. For example, it can prevent a repository override
from weakening required branch protection.

Validators are loaded from configuration and run while settings are merged.
See [`lib/settings.js`](../lib/settings.js#L690-L709) and
[`lib/settings.js`](../lib/settings.js#L1752-L1771).

> [!CAUTION]
> Validator scripts are administrator-supplied JavaScript and receive the
> Octokit client as `githubContext`. A validator could make GitHub API calls if
> its script explicitly does so. Built-in dry-run protections do not guarantee
> that arbitrary custom validator code is read-only.

Validation failures are surfaced as errors and cause the dry-run check to
finish with a failure conclusion.

## Result scope and reporting

Changing the global settings file triggers a full synchronization preview.
Changing only repository or suborganization files limits evaluation to the
affected scope.

Safe Settings filters pull request results using the base-branch configuration.
This filtering keeps changes introduced by the pull request and generally
removes unrelated pre-existing drift.

The result can contain:

* Repositories considered and affected
* Field-level additions, modifications, and deletions
* Validation or API errors
* Informational messages for disabled plugins
* Deletions suppressed by additive plugin behavior

Large reports can be split across multiple pull request comments. The check run
finishes successfully when no error records exist and fails when one or more
errors are present.

## Full synchronization in dry-run mode

A full installation synchronization can run in NOP mode by setting the
following environment variable:

```bash
FULL_SYNC_NOP=true npm run full-sync
```

The flag is defined in [`lib/env.js`](../lib/env.js#L12), and the full-sync
entry point passes it to installation synchronization in
[`full-sync.js`](../full-sync.js#L1-L23).

This mode still reads configuration from the configured admin repository and
compares it with live GitHub state. It does not evaluate uncommitted local admin
repository YAML.

## Summary

A Safe Settings dry run loads proposed committed configuration, applies merge
and validation rules, reads the current live GitHub state, and reports the
changes required to reach the desired state. Built-in plugins do not apply
those target settings during the dry run. Uncommitted local YAML is outside the
pull request dry-run flow.
