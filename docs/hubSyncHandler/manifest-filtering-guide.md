# Manifest Filtering Guide: Controlling Hub-Sync Distribution

**Purpose**: This guide explains how to use `manifest.yml` to control which organizations receive which files during hub-sync operations.

**Last Updated**: 2026-07-08

---

## ⚠️ Before You Begin: Critical Concepts

**Read this first to avoid configuration conflicts:**

1. **Only `settings.yml` merges** - It's the ONLY file where globals and organizations versions are merged at YAML level
2. **All other files REPLACE** - Files like `suborgs/backend.yml` exsiting in organizations/ and globals/ will OVERWRITE each other, depending on last update
3. **Choose one source** - For files with the same name, except settings.yml, choose one location: globals/ (shared) OR organizations/ (custom), not both
4. **Manifest controls distribution** - Only orgs listed in manifest `include` rules are sync'd via HubSync

**Quick Decision Tree:**
- Want merged behavior? → Use `settings.yml` only
- Want shared config across orgs? → Use `globals/` + manifest includes
- Want org-specific config? → Use `organizations/<org>/` + different filename than `globals/`
- Want customizations that also receive updates? → Not supported (except `settings.yml`)

---

## Overview

The manifest.yml file provides **two levels of filtering** for hub-sync:

1. **Globals/ Distribution** - Control which orgs receive which files from `globals/`
2. **Organizations/ Sync Control** - Control which `organizations/<org>/` folders sync (ignore/skip specific orgs or files)

Both mechanisms use the same manifest.yml rules with `org_targets` and `files_to_sync` patterns.

### Key Concepts

**Globals/ Distribution (One-to-Many)**:
- Files in `globals/` (including `globals/suborgs/`) are **distributed** to multiple organizations
- One file → many orgs (based on manifest rules)
- Example: `globals/suborgs/backend.yml` can sync to org-1, org-2, org-3
- Use Case: Shared configurations, team templates, common suborg definitions

**Organizations/ Sync (One-to-One)**:
- Files in `organizations/<org-name>/` sync only to that **specific** organization
- One folder → one org (manifest can exclude certain orgs or files)
- Example: `organizations/org-1/suborgs/custom.yml` only syncs to org-1
- Use Case: Org-specific overrides, unique suborg configurations

---

## Rule Precedence and Conflict Resolution

### How Rules Are Evaluated

Manifest rules use **OR logic** across multiple rules with **first-match-wins** behavior:

1. **Rules are evaluated in ORDER** - Top-to-bottom in the YAML array
2. **ANY rule can include** - If ANY enabled rule includes an org/file, it syncs
3. **Within each rule**: `exclude` is checked FIRST, then `include`
4. **First match wins** - As soon as a rule includes something, evaluation stops (returns TRUE)
5. **If excluded by one rule** - Continues checking the next rule
6. **No match = excluded** - If no rule includes it, it's excluded by default

### Rule Precedence Matrix

| Scenario | Rule 1 | Rule 2 | Result | Reason |
|----------|--------|--------|--------|--------|
| Both include | ✅ Include | ✅ Include | ✅ Synced | Rule 1 matches first, returns TRUE |
| First excludes, second includes | ❌ Exclude | ✅ Include | ✅ Synced | Rule 1 skips, Rule 2 includes |
| First includes, second excludes | ✅ Include | ❌ Exclude | ✅ Synced | Rule 1 matches first, Rule 2 never checked |
| Both exclude | ❌ Exclude | ❌ Exclude | ❌ Skipped | No rule includes it |

### Example: Conflicting Rules

```yaml
rules:
  # Rule 1: Specific file to specific org
  - name: test-file-to-test-org
    enabled: true
    org_targets:
      include: ["ORG-TEST"]
    files_to_sync:
      include: ["suborgs/test.yml"]
  
  # Rule 2: All files to all orgs
  - name: all-files-to-all-orgs
    enabled: true
    org_targets:
      include: ["*"]
    files_to_sync:
      include: ["*.yml", "suborgs/*.yml"]
```

**Question**: Does `suborgs/test.yml` sync to `ORG-TEST`?

**Answer**: ✅ **YES** - Rule 1 matches first and includes it. Rule 2 would also match, but Rule 1 already returned TRUE.

**Question**: Does `suborgs/test.yml` sync to `ORG-PROD`?

**Answer**: ✅ **YES** - Rule 1 doesn't match ORG-PROD (continues), Rule 2 matches ORG-PROD and the file pattern.

**Question**: Does `suborgs/other.yml` sync to `ORG-TEST`?

**Answer**: ✅ **YES** - Rule 1 doesn't match file pattern (continues), Rule 2 matches both org and file.

### Example: Exclude Override with Multiple Rules

```yaml
rules:
  # Rule 1: Exclude test file from test org
  - name: block-test-file
    enabled: true
    org_targets:
      include: ["ORG-TEST"]
    files_to_sync:
      include: ["*.yml"]
      exclude: ["suborgs/test.yml"]  # Explicitly exclude
  
  # Rule 2: All files to all orgs
  - name: all-files-all-orgs
    enabled: true
    org_targets:
      include: ["*"]
    files_to_sync:
      include: ["suborgs/*.yml"]
```

**Question**: Does `suborgs/test.yml` sync to `ORG-TEST`?

**Answer**: ✅ **YES** (Surprising!) - Here's why:
1. Rule 1 matches ORG-TEST
2. Rule 1 checks exclude first → matches `suborgs/test.yml` → EXCLUDED by this rule
3. Rule 1 **continues** to Rule 2 (doesn't return FALSE, just moves to next rule)
4. Rule 2 matches ORG-TEST (wildcard `*`)
5. Rule 2 includes `suborgs/*.yml` → INCLUDED
6. Returns TRUE - **file syncs**

**Key Insight**: An exclude in one rule doesn't prevent another rule from including it. Rules use OR logic.

### Example: True Exclusion Pattern

If you want to **truly prevent** a file from syncing to an org, you need to **not have ANY rule that includes it**:

```yaml
rules:
  # Rule 1: Most orgs get all files
  - name: standard-orgs
    enabled: true
    org_targets:
      include: ["*"]
      exclude: ["ORG-TEST"]  # Exclude ORG-TEST from this rule
    files_to_sync:
      include: ["suborgs/*.yml"]
  
  # Rule 2: ORG-TEST gets selective files only
  - name: test-org-limited
    enabled: true
    org_targets:
      include: ["ORG-TEST"]
    files_to_sync:
      include: ["suborgs/allowed.yml"]  # Only specific files
      exclude: ["suborgs/test.yml"]     # Not included here
```

**Result**: `suborgs/test.yml` does NOT sync to ORG-TEST because:
- Rule 1 excludes ORG-TEST entirely
- Rule 2 only includes `suborgs/allowed.yml`, not `suborgs/test.yml`
- No rule includes the file for ORG-TEST → excluded

### Within-Rule Precedence

Within a **single rule**, exclude always wins:

```yaml
rules:
  - name: confusing-rule
    org_targets:
      include: ["*"]
    files_to_sync:
      include: ["suborgs/*.yml"]
      exclude: ["suborgs/test.yml"]
```

**Result**: All `suborgs/*.yml` files sync **EXCEPT** `suborgs/test.yml` (exclude wins within this rule).

### Best Practice: Order Rules from Specific to General

```yaml
rules:
  # Rule 1: Specific exceptions first
  - name: test-org-exceptions
    enabled: true
    org_targets:
      include: ["ORG-TEST"]
    files_to_sync:
      include: ["settings.yml"]  # ONLY settings.yml
  
  # Rule 2: General rules second
  - name: all-other-orgs
    enabled: true
    org_targets:
      include: ["*"]
      exclude: ["ORG-TEST"]  # Already handled above
    files_to_sync:
      include: ["*.yml"]  # All files
```

**Advantage**: 
- Specific rules are evaluated first
- General rules don't conflict because specific orgs are excluded
- Clear intent and easier to debug

### Rule Order Matters: Example

```yaml
# Scenario A: General rule FIRST
rules:
  - name: all-files-all-orgs
    org_targets:
      include: ["*"]
    files_to_sync:
      include: ["*.yml"]
  
  - name: test-org-limited    # Never evaluated for files!
    org_targets:
      include: ["ORG-TEST"]
    files_to_sync:
      include: ["settings.yml"]
      exclude: ["suborgs/*.yml"]
```

**Result**: ORG-TEST gets ALL files because Rule 1 matches first and returns TRUE. Rule 2 never gets a chance to exclude `suborgs/*.yml`.

```yaml
# Scenario B: Specific rule FIRST (Correct)
rules:
  - name: test-org-limited
    org_targets:
      include: ["ORG-TEST"]
    files_to_sync:
      include: ["settings.yml"]  # Only this
  
  - name: all-other-orgs
    org_targets:
      include: ["*"]
      exclude: ["ORG-TEST"]
    files_to_sync:
      include: ["*.yml"]
```

**Result**: ORG-TEST gets ONLY `settings.yml` (Rule 1 matches first), other orgs get all files (Rule 2).

---

## ⚠️ CRITICAL: File Merge vs. Replace Behavior

Understanding this distinction is **essential** for proper configuration management.

### `settings.yml` - MERGE Behavior (Special Case)

`settings.yml` is the **ONLY** file that supports deep YAML merge between globals and organizations.

**How it works**:
1. **When `organizations/org-1/settings.yml` changes**:
   - Hub-sync merges `globals/settings.yml` + `organizations/org-1/settings.yml`
   - Deploys merged result ONLY to `org-1` (if manifest allows)
   
2. **When `globals/settings.yml` changes**:
   - Hub-sync merges `globals/settings.yml` with EACH org's `organizations/<org>/settings.yml`
   - Deploys to ALL orgs listed in manifest include rules
   - Does NOT deploy to `org-3` if not in manifest

**Example**:
```yaml
# globals/settings.yml
repository:
  has_issues: true
  has_wiki: false

# organizations/org-1/settings.yml
repository:
  has_projects: true
  delete_branch_on_merge: true

# Merged result deployed to org-1:
repository:
  has_issues: true              # From globals
  has_wiki: false               # From globals
  has_projects: true            # From org-1
  delete_branch_on_merge: true  # From org-1
```

### All Other Files - REPLACE Behavior

**Every file except `settings.yml` uses REPLACE (overwrite) behavior.**

**How it works**:
- If `globals/suborgs/backend.yml` exists AND `organizations/org-1/suborgs/backend.yml` exists
- When `globals/suborgs/backend.yml` changes:
  - Hub-sync deploys globals version to org-1 (if manifest allows)
  - **COMPLETELY OVERWRITES** `organizations/org-1/suborgs/backend.yml`
  - Org-specific customizations are LOST

**This creates a conflict scenario**:

| Scenario | Files Present | What Happens | Problem |
|----------|---------------|--------------|---------|
| Globals change | `globals/suborgs/backend.yml` + `organizations/org-1/suborgs/backend.yml` | Globals REPLACES org version | Org customizations lost |
| Exclude org from manifest | Same | Globals deployment skipped | Org never gets globals updates |

**You cannot have both** without choosing one or the other.

---

## Configuration Patterns

### ✅ Correct Pattern 1: Shared Configuration

Use `globals/` for configurations that should be **identical** across organizations.

```
.github/safe-settings/
├── globals/
│   └── suborgs/
│       └── backend.yml          # Shared backend suborg
└── organizations/
    ├── org-1/
    │   └── settings.yml         # Only settings.yml can exist in both
    └── org-2/
        └── settings.yml
```

**Manifest**:
```yaml
rules:
  - name: all-orgs-shared-suborgs
    org_targets:
      include: ["org-1", "org-2"]
    files_to_sync:
      include: ["suborgs/*.yml"]
```

**Result**: All orgs get identical `backend.yml` from globals.

---

### ✅ Correct Pattern 2: Org-Specific Configuration

Use `organizations/<org>/` for configurations that are **unique per org**.

```
.github/safe-settings/
├── globals/
│   └── settings.yml             # Only settings.yml in globals
└── organizations/
    ├── org-1/
    │   ├── settings.yml
    │   └── suborgs/
    │       └── custom-backend.yml    # Unique to org-1
    └── org-2/
        ├── settings.yml
        └── suborgs/
            └── custom-frontend.yml   # Unique to org-2
```

**Manifest**:
```yaml
rules:
  - name: org-1-custom
    org_targets:
      include: ["org-1"]
    files_to_sync:
      include: ["suborgs/*.yml"]
  
  - name: org-2-custom
    org_targets:
      include: ["org-2"]
    files_to_sync:
      include: ["suborgs/*.yml"]
```

**Result**: Each org gets only its own custom suborg configs.

---

### ❌ Anti-Pattern: Duplicate File Paths

**AVOID** having the same file path in both `globals/` and `organizations/<org>/`.

```
.github/safe-settings/
├── globals/
│   └── suborgs/
│       └── backend.yml          # ⚠️ Conflict!
└── organizations/
    └── org-1/
        └── suborgs/
            └── backend.yml      # ⚠️ Will be overwritten, by lastest update
```

**Why this fails**:
1. If manifest includes org-1: Globals overwrites org-1's custom version
2. If manifest excludes org-1: Org-1 never gets globals updates
3. No way to maintain org-specific customizations

**Exception**: Only `settings.yml` can safely exist in both locations due to merge behavior.

---

### ✅ Correct Pattern 3: Selective Distribution with Naming

Use **different filenames** for shared vs. org-specific configs.

```
.github/safe-settings/
├── globals/
│   └── suborgs/
│       ├── shared-backend.yml       # Shared template
│       └── shared-frontend.yml      # Shared template
└── organizations/
    └── org-1/
        └── suborgs/
            └── org1-custom-team.yml # Org-specific custom
```

**Manifest**:
```yaml
rules:
  - name: distribute-shared-suborgs
    org_targets:
      include: ["*"]
    files_to_sync:
      include: ["suborgs/shared-*.yml"]  # Only shared templates
```

**Result**: 
- All orgs get shared templates from globals
- Each org maintains unique custom suborgs without conflicts

---

## Manifest.yml Implications

### For `settings.yml` (Merge Behavior)

```yaml
rules:
  - name: production-orgs
    org_targets:
      include: ["org-1", "org-2", "prod-*"]
    files_to_sync:
      include: ["settings.yml"]
```

**When `globals/settings.yml` changes**:
- ✅ Merges with `organizations/org-1/settings.yml` → deploys to org-1
- ✅ Merges with `organizations/org-2/settings.yml` → deploys to org-2
- ✅ Merges with each `organizations/prod-*/settings.yml` → deploys to matching orgs
- ❌ Does NOT deploy to `org-3` (not in manifest)

### For All Other Files (Replace Behavior)

```yaml
rules:
  - name: backend-suborg-distribution
    org_targets:
      include: ["org-1", "org-2"]
    files_to_sync:
      include: ["suborgs/backend.yml"]
```

**When `globals/suborgs/backend.yml` changes**:
- ✅ Deploys to org-1 (REPLACES `organizations/org-1/suborgs/backend.yml` if it exists)
- ✅ Deploys to org-2 (REPLACES `organizations/org-2/suborgs/backend.yml` if it exists)
- ⚠️ Any org-specific customizations in `organizations/<org>/suborgs/backend.yml` are LOST

**Solution**: Don't create `organizations/<org>/suborgs/backend.yml` if you want globals to distribute.

---

## Sample Hub Config Structure

```
.github/safe-settings/
├── globals/
│   ├── manifest.yml              # Controls ALL sync rules
│   ├── suborgs/
│   │   └── backend.yml
│   └── settings.yml              # Glocal Base configuration (distributed)
│
└── organizations/
    ├── org-name-1/
    │   ├── repos/
    │   │   └── repo-x.yml
    │   ├── suborgs/
    │   │   └── frontend.yml
    │   └── settings.yml          # Org-specific override/additions
    │
    └── org-name-2/
        ├── repos/
        │   └── repo-y.yml
        ├── suborgs/
        │   └── frontend.yml
        └── settings.yml          # Org-specific override/additions
```

---

## Use Case 1: Globals/ Distribution Control

**Goal**: Control which organizations receive files from `globals/` folder.

### Example Scenario

You have `globals/settings.yml` and want to:
- ✅ Deploy to `org-name-1` and `org-name-2`
- ❌ NOT deploy to `test-org` or `sandbox-*` orgs

### Manifest Configuration

```yaml
# .github/safe-settings/globals/manifest.yml

rules:
  # Production orgs get globals/ files
  - name: production-orgs
    enabled: true
    org_targets:
      include:
        - "org-name-1"
        - "org-name-2"
        - "prod-*"              # Wildcard for all prod orgs
      exclude:
        - "test-*"              # Exclude all test orgs
        - "sandbox-*"           # Exclude all sandbox orgs
    files_to_sync:
      include:
        - "settings.yml"
        - "suborgs/*.yml"       # All suborg configs
    mergeStrategy: merge
```

### What Happens

| File Changed | org-name-1 | org-name-2 | test-org | sandbox-123 |
|--------------|------------|------------|----------|-------------|
| `globals/settings.yml` | ✅ Synced | ✅ Synced | ❌ Skipped | ❌ Skipped |
| `globals/suborgs/common.yml` | ✅ Synced | ✅ Synced | ❌ Skipped | ❌ Skipped |

**Code Flow**:
1. PR changes `globals/settings.yml`
2. Hub-sync loads manifest.yml
3. Filters orgs: `["org-name-1", "org-name-2"]` (test-org and sandbox excluded)
4. Distributes file to filtered orgs only

---

## Use Case 1b: Globals/Suborgs/ Distribution

**Goal**: Distribute suborg configurations from `globals/suborgs/` to selected organizations.

### Example Scenario

You have multiple suborg config files in `globals/suborgs/`:
- `globals/suborgs/backend.yml` - Backend team suborg config
- `globals/suborgs/frontend.yml` - Frontend team suborg config
- `globals/suborgs/mobile.yml` - Mobile team suborg config

You want to:
- ✅ Distribute ALL suborg configs to `org-name-1` (full-stack org)
- ✅ Distribute ONLY `frontend.yml` to `org-name-2` (frontend-only org)
- ❌ NOT distribute any suborg configs to `test-org`

### Manifest Configuration

```yaml
# .github/safe-settings/globals/manifest.yml

rules:
  # org-name-1 gets all suborg configs (full-stack)
  - name: org1-all-suborgs
    enabled: true
    org_targets:
      include:
        - "org-name-1"
    files_to_sync:
      include:
        - "settings.yml"
        - "suborgs/*.yml"      # All suborg configs
    mergeStrategy: merge
  
  # org-name-2 gets only frontend suborg (frontend-only)
  - name: org2-frontend-only
    enabled: true
    org_targets:
      include:
        - "org-name-2"
    files_to_sync:
      include:
        - "settings.yml"
        - "suborgs/frontend.yml"  # Only frontend
      exclude:
        - "suborgs/backend.yml"   # Exclude backend
        - "suborgs/mobile.yml"    # Exclude mobile
    mergeStrategy: merge
```

### What Happens

| File Changed | org-name-1 | org-name-2 | test-org |
|--------------|------------|------------|----------|
| `globals/suborgs/backend.yml` | ✅ Synced | ❌ Excluded | ❌ No rule |
| `globals/suborgs/frontend.yml` | ✅ Synced | ✅ Synced | ❌ No rule |
| `globals/suborgs/mobile.yml` | ✅ Synced | ❌ Excluded | ❌ No rule |

**Result**: 
- org-name-1 receives all three suborg configs
- org-name-2 receives only frontend.yml
- test-org receives nothing (no matching rule)

**Real-World Use Case**: 
When you update `globals/suborgs/backend.yml` to add a new backend team repository:
1. Change pushed to hub's `globals/suborgs/backend.yml`
2. Hub-sync distributes to: ✅ org-name-1 (has full-stack teams)
3. Hub-sync skips: ❌ org-name-2 (frontend-only, doesn't need backend config)

---

## Use Case 2: Organizations/ Sync Control (Ignore Specific Orgs)

**Goal**: Ignore certain `organizations/<org>/` folders entirely, even when files change.

### Example Scenario

You have org folders in hub but want to:
- ✅ Sync `organizations/org-name-1/` → to org-name-1
- ✅ Sync `organizations/org-name-2/` → to org-name-2  
- ❌ IGNORE `organizations/test-org/` (keep in hub for reference only)
- ❌ IGNORE `organizations/sandbox-*/` (drafts/experiments)

### Manifest Configuration

```yaml
# .github/safe-settings/globals/manifest.yml

rules:
  # Only sync production organization folders
  - name: production-orgs-only
    enabled: true
    org_targets:
      include:
        - "org-name-1"
        - "org-name-2"
        - "prod-*"
      exclude:
        - "test-*"              # Don't sync test org folders
        - "sandbox-*"           # Don't sync sandbox org folders
        - "*-draft"             # Don't sync draft org folders
    files_to_sync:
      include:
        - "*.yml"
    mergeStrategy: merge
```

### What Happens

| File Changed | Sync Action | Reason |
|--------------|-------------|---------|
| `organizations/org-name-1/settings.yml` | ✅ Synced to org-name-1 | Org matches rule |
| `organizations/org-name-2/settings.yml` | ✅ Synced to org-name-2 | Org matches rule |
| `organizations/test-org/settings.yml` | ❌ IGNORED | Org excluded by manifest |
| `organizations/sandbox-123/settings.yml` | ❌ IGNORED | Org excluded by manifest |

**Key Point**: Files in `organizations/test-org/` can exist in hub for documentation/reference but will NOT sync to the org.

---

## Use Case 3: Ignore Specific Files Within Organizations/

**Goal**: Sync an org folder but exclude certain files (drafts, notes, experimental configs).

### Example Scenario

For `org-name-1`:
- ✅ Sync `settings.yml`
- ✅ Sync `repos/prod-*.yml`
- ❌ IGNORE `draft-*.yml` files
- ❌ IGNORE `repos/experimental-*.yml` files

### Manifest Configuration

```yaml
# .github/safe-settings/globals/manifest.yml

rules:
  # org-name-1 with file filtering
  - name: org1-with-exclusions
    enabled: true
    org_targets:
      include:
        - "org-name-1"
    files_to_sync:
      include:
        - "*.yml"
        - "repos/*.yml"
        - "suborgs/*.yml"
      exclude:
        - "draft-*.yml"                   # Ignore draft files
        - "notes.yml"                     # Ignore notes
        - "repos/experimental-*.yml"      # Ignore experimental repos
    mergeStrategy: merge
  
  # org-name-2 gets everything (no exclusions)
  - name: org2-full-sync
    enabled: true
    org_targets:
      include:
        - "org-name-2"
    files_to_sync:
      include:
        - "*.yml"
        - "repos/*.yml"
        - "suborgs/*.yml"
    mergeStrategy: merge
```

### What Happens

| File Changed | org-name-1 | org-name-2 |
|--------------|------------|------------|
| `organizations/org-name-1/settings.yml` | ✅ Synced | ❌ N/A |
| `organizations/org-name-1/draft-settings.yml` | ❌ IGNORED | ❌ N/A |
| `organizations/org-name-1/repos/prod-api.yml` | ✅ Synced | ❌ N/A |
| `organizations/org-name-1/repos/experimental-feature.yml` | ❌ IGNORED | ❌ N/A |
| `organizations/org-name-2/settings.yml` | ❌ N/A | ✅ Synced |
| `organizations/org-name-2/draft-settings.yml` | ❌ N/A | ✅ Synced |

---

## Combined Example: Complete Manifest

This example covers **all use cases** together:

```yaml
# .github/safe-settings/globals/manifest.yml

rules:
  # ============================================================================
  # Rule 1: Production orgs get globals/ files
  # ============================================================================
  - name: production-globals-distribution
    enabled: true
    org_targets:
      include:
        - "org-name-1"
        - "org-name-2"
        - "prod-*"
      exclude:
        - "test-*"
        - "sandbox-*"
    files_to_sync:
      include:
        - "settings.yml"
        - "suborgs/*.yml"
    mergeStrategy: merge
  
  # ============================================================================
  # Rule 2: org-name-1 syncs with file exclusions
  # ============================================================================
  - name: org1-with-file-filtering
    enabled: true
    org_targets:
      include:
        - "org-name-1"
    files_to_sync:
      include:
        - "*.yml"
        - "repos/*.yml"
        - "suborgs/*.yml"
      exclude:
        - "draft-*.yml"
        - "notes.yml"
        - "repos/experimental-*.yml"
    mergeStrategy: merge
  
  # ============================================================================
  # Rule 3: org-name-2 syncs everything (no exclusions)
  # ============================================================================
  - name: org2-full-sync
    enabled: true
    org_targets:
      include:
        - "org-name-2"
    files_to_sync:
      include:
        - "*.yml"
        - "repos/*.yml"
        - "suborgs/*.yml"
    mergeStrategy: merge
  
  # ============================================================================
  # Test and sandbox orgs are implicitly excluded (no rules match them)
  # ============================================================================
```

### Complete Behavior Table

| File Changed | org-name-1 | org-name-2 | test-org | sandbox-123 |
|--------------|------------|------------|----------|-------------|
| **Globals Distribution** | | | | |
| `globals/settings.yml` | ✅ Rule 1 | ✅ Rule 1 | ❌ Excluded | ❌ Excluded |
| `globals/suborgs/frontend.yml` | ✅ Rule 1 | ✅ Rule 1 | ❌ Excluded | ❌ Excluded |
| **Organizations/ Sync** | | | | |
| `organizations/org-name-1/settings.yml` | ✅ Rule 2 | ❌ N/A | ❌ N/A | ❌ N/A |
| `organizations/org-name-1/draft-config.yml` | ❌ Excluded | ❌ N/A | ❌ N/A | ❌ N/A |
| `organizations/org-name-1/repos/prod-api.yml` | ✅ Rule 2 | ❌ N/A | ❌ N/A | ❌ N/A |
| `organizations/org-name-1/repos/experimental-x.yml` | ❌ Excluded | ❌ N/A | ❌ N/A | ❌ N/A |
| `organizations/org-name-2/settings.yml` | ❌ N/A | ✅ Rule 3 | ❌ N/A | ❌ N/A |
| `organizations/org-name-2/draft-config.yml` | ❌ N/A | ✅ Rule 3 | ❌ N/A | ❌ N/A |
| `organizations/test-org/settings.yml` | ❌ N/A | ❌ N/A | ❌ No rule | ❌ N/A |
| `organizations/sandbox-123/settings.yml` | ❌ N/A | ❌ N/A | ❌ N/A | ❌ No rule |

---

## Pattern Matching Rules

### Wildcards

- `*` - Matches any characters
  - `test-*` matches `test-org`, `test-prod`, `test-123`
  - `*.yml` matches `settings.yml`, `config.yml`, etc.
  
- `**` - Matches any directory depth
  - `**/repos/*.yml` matches `repos/api.yml` and `suborgs/repos/api.yml`

- `?` - Matches single character
  - `org-?` matches `org-1`, `org-a`, but not `org-12`

### Literal Strings

```yaml
org_targets:
  include:
    - "org-name-1"           # Exact match only
    - "prod-org-specific"    # Exact match only
```

### Exclude Takes Precedence

```yaml
org_targets:
  include:
    - "prod-*"               # Matches all prod-* orgs
  exclude:
    - "prod-test-*"          # But excludes prod-test-* orgs
```

Result:
- ✅ `prod-api` included
- ✅ `prod-web` included  
- ❌ `prod-test-123` excluded (exclude takes precedence)

---

## How It Works: Code Flow

### Globals/ Distribution

```javascript
// lib/hubSyncHandler.js - syncHubGlobalsUpdate()

1. Load manifest.yml
2. Get all organizations with app installations
3. Filter orgs by manifest rules → ["org-name-1", "org-name-2"]
4. For each changed file in globals/:
   - Check if file matches manifest patterns
   - If yes, distribute to ALL filtered orgs
   - If no, skip file
```

### Organizations/ Sync

```javascript
// lib/hubSyncHandler.js - syncHubOrgUpdate()

1. Load manifest.yml
2. Detect changed files in organizations/org-name-1/
3. Check if org-name-1 matches manifest org_targets
   - If no, skip entire org folder
4. Filter files by manifest files_to_sync patterns
5. Sync only matched files to org-name-1
```

---

## Troubleshooting

### Issue: Org not receiving globals/ files

**Diagnostic Steps**:

1. Check manifest.yml rules - does org match any `org_targets.include` pattern?
   ```yaml
   org_targets:
     include:
       - "org-name-1"  # Does your org match?
   ```

2. Check if org is explicitly excluded:
   ```yaml
   org_targets:
     exclude:
       - "test-*"      # Is your org in exclude list?
   ```

3. Check logs for: `Organization {name} excluded by manifest rules - skipping sync`

4. Verify at least one rule has `enabled: true`

### Issue: Organizations/ folder not syncing

**Diagnostic Steps**:

1. Check if org matches manifest:
   ```bash
   # Look for this in logs
   "Organization org-name-1 excluded by manifest rules - skipping sync"
   ```

2. Check if files are excluded:
   ```bash
   # Look for this in logs
   "All 3 file(s) for org org-name-1 were excluded by manifest rules"
   ```

3. Verify folder name matches exactly:
   - Folder: `organizations/org-name-1/` 
   - Manifest: `org_targets: include: ["org-name-1"]`
   - Must match exactly (case-sensitive)

### Issue: Specific file not syncing

**Diagnostic Steps**:

1. Check file pattern match:
   ```yaml
   files_to_sync:
     include:
       - "*.yml"           # Does your file match?
     exclude:
       - "draft-*.yml"     # Is your file excluded?
   ```

2. Check logs for: `File {path} excluded by manifest rules - skipping`

3. Test pattern matching:
   - File: `draft-settings.yml`
   - Pattern: `draft-*.yml`
   - Result: ❌ Excluded (matches exclude pattern)

### Debugging Tips

Enable debug logging to see pattern matching:

```yaml
# Manifest rule with debug-friendly name
rules:
  - name: debug-org-name-1  # Clear name helps identify rule in logs
    enabled: true
    org_targets:
      include: ["org-name-1"]
```

Look for these log entries:
- `"Org org-name-1 included by rule 'debug-org-name-1'"`
- `"File settings.yml included by rule 'debug-org-name-1'"`
- `"Org test-org not matched by any manifest rule - excluding from sync"`

### Troubleshooting Rule Conflicts

#### Issue: File unexpectedly syncing despite exclude rule

**Symptom**: You added an exclude in one rule, but the file still syncs.

**Example**:
```yaml
rules:
  - name: exclude-test-files
    org_targets: 
      include: ["ORG-PROD"]
    files_to_sync:
      exclude: ["suborgs/test.yml"]  # Trying to block this
  
  - name: all-files-all-orgs
    org_targets:
      include: ["*"]
    files_to_sync:
      include: ["suborgs/*.yml"]      # But this includes it!
```

**Why**: Rule 2 includes the file for ORG-PROD, overriding Rule 1's exclude. Rules use OR logic.

**Solution**: Use org exclusion instead of file exclusion:
```yaml
rules:
  - name: all-files-most-orgs
    org_targets:
      include: ["*"]
      exclude: ["ORG-PROD"]          # Exclude org from this rule
    files_to_sync:
      include: ["suborgs/*.yml"]
  
  - name: prod-selective-files
    org_targets:
      include: ["ORG-PROD"]
    files_to_sync:
      include: ["settings.yml"]       # Only specific files
      # suborgs/test.yml NOT included
```

#### Issue: Specific rule being ignored

**Symptom**: You created a specific rule for an org, but a general rule seems to override it.

**Example**:
```yaml
rules:
  - name: all-orgs-all-files
    org_targets: ["*"]
    files_to_sync: ["*.yml"]
  
  - name: test-org-settings-only   # Never reached!
    org_targets: ["ORG-TEST"]
    files_to_sync: ["settings.yml"]
```

**Why**: Rule 1 matches first (first-match-wins), so Rule 2 never evaluates.

**Solution**: Reorder rules - specific before general:
```yaml
rules:
  - name: test-org-settings-only    # Check this first
    org_targets: ["ORG-TEST"]
    files_to_sync: ["settings.yml"]
  
  - name: all-other-orgs-all-files  # Then general
    org_targets: 
      include: ["*"]
      exclude: ["ORG-TEST"]          # Exclude already-handled orgs
    files_to_sync: ["*.yml"]
```

#### Issue: Can't figure out which rule is matching

**Symptom**: File syncs but you don't know why.

**Solution**: Use clear rule names and check logs:

```yaml
rules:
  - name: PROD-ONLY-settings         # Clear naming convention
    org_targets: ["ORG-PROD"]
    files_to_sync: ["settings.yml"]
  
  - name: ALL-ORGs-suborgs           # Indicates scope
    org_targets: ["*"]
    files_to_sync: ["suborgs/*.yml"]
```

Enable debug logging and search for:
```
"Org ORG-PROD included by rule 'PROD-ONLY-settings'"
"File suborgs/backend.yml included by rule 'ALL-ORGs-suborgs'"
```

#### Issue: Exclude pattern not working as expected

**Symptom**: Pattern like `exclude: ["suborgs/test.yml"]` doesn't match.

**Why**: The file path being matched might be different (e.g., full path vs relative path).

**Patterns checked** (from code):
1. Just filename: `test.yml`
2. Relative path (last 2 segments): `suborgs/test.yml`
3. Full path: `globals/suborgs/test.yml` or `organizations/org-1/suborgs/test.yml`

**Solution**: Use multiple patterns or glob matching:
```yaml
files_to_sync:
  exclude: 
    - "test.yml"               # Matches filename
    - "suborgs/test.yml"       # Matches relative path
    - "**/test.yml"            # Glob matches anywhere
```

### Issue: Org-specific customizations being overwritten

**Symptom**: You have `organizations/org-1/suborgs/backend.yml` with custom content, but it keeps getting replaced with `globals/suborgs/backend.yml`.

**Root Cause**: Non-settings.yml files use REPLACE behavior. When `globals/suborgs/backend.yml` is distributed, it OVERWRITES the org-specific version.

**Solution Options**:

**Option 1: Use Different Filenames** (Recommended)
```
.github/safe-settings/
├── globals/
│   └── suborgs/
│       └── shared-backend.yml    # Shared template
└── organizations/
    └── org-1/
        └── suborgs/
            └── org1-backend.yml  # Org-specific custom
```

**Option 2: Exclude Org from Globals Distribution**
```yaml
rules:
  - name: backend-suborg-to-most-orgs
    org_targets:
      include: ["*"]
      exclude: ["org-1"]  # org-1 maintains its own custom version
    files_to_sync:
      include: ["suborgs/backend.yml"]
```

**Trade-off**: org-1 will never receive globals updates for `backend.yml`.

**Option 3: Remove Org-Specific Version**

If globals should be the source of truth, delete `organizations/org-1/suborgs/backend.yml` entirely and let globals distribute.

### Issue: "I need org-specific customizations but also want globals updates"

**Symptom**: You want `organizations/org-1/suborgs/backend.yml` to receive updates from `globals/suborgs/backend.yml` BUT also maintain org-specific additions.

**Reality**: This is **NOT supported** except for `settings.yml`.

**Why**: Only `settings.yml` has deep YAML merge capability. All other files use simple REPLACE.

**Workaround Options**:

**Option 1: Use `settings.yml` for mergeable content**

Move mergeable configuration into `settings.yml`:
```yaml
# globals/settings.yml
suborgs:
  backend:
    name: "backend-team"
    permission: "push"

# organizations/org-1/settings.yml
suborgs:
  backend:
    org_specific_field: "custom-value"  # This will merge
```

**Option 2: Use inheritance via naming**
```
globals/suborgs/backend-base.yml      # Shared baseline
organizations/org-1/suborgs/backend-custom.yml   # Org additions
```

Application layer loads both files and merges them.

**Option 3: Accept globals as source of truth**

Remove org-specific customizations and manage everything from globals with conditional logic:

```yaml
# globals/suborgs/backend.yml
teams:
  - name: backend
    permission: push
  - name: backend-org1
    permission: admin
    orgs: ["org-1"]  # Conditional for org-1
```

### Issue: Manifest exclude creates a deadlock

**Symptom**: 
- I want `organizations/org-1/suborgs/backend.yml` to NOT be overwritten by globals
- So I exclude org-1 from manifest
- But now org-1 never gets ANY globals updates for suborgs

**Root Cause**: Manifest rules are file-pattern based, not merge-aware.

**Solution**: This is the expected behavior. You must choose:

**Choice A: Globals Distribution** (Recommended for most orgs)
- Remove `organizations/org-1/suborgs/backend.yml`
- Include org-1 in manifest
- Globals distributes and updates automatically

**Choice B: Org-Specific Management** (For unique orgs)
- Keep `organizations/org-1/suborgs/backend.yml`
- Exclude org-1 from manifest
- Manually maintain org-1's configuration

**You cannot have both** unless you use different filenames (see Option 1 above).

---

## Best Practices

### 1. Use Descriptive Rule Names

✅ **Good**:
```yaml
rules:
  - name: production-orgs-full-sync
  - name: test-orgs-limited-sync
  - name: draft-org-no-sync
```

❌ **Bad**:
```yaml
rules:
  - name: rule-1
  - name: rule-2
```

### 2. Start Broad, Refine Incrementally

**Phase 1**: Start with everything
```yaml
rules:
  - name: all-orgs-all-files
    org_targets:
      include: ["*"]
    files_to_sync:
      include: ["*.yml"]
```

**Phase 2**: Add exclusions
```yaml
rules:
  - name: all-except-test
    org_targets:
      include: ["*"]
      exclude: ["test-*"]  # Added exclusion
    files_to_sync:
      include: ["*.yml"]
```

**Phase 3**: Add file filtering
```yaml
rules:
  - name: production-filtered
    org_targets:
      include: ["prod-*"]
    files_to_sync:
      include: ["*.yml"]
      exclude: ["draft-*.yml"]  # Added file exclusion
```

### 3. Document Intent with Comments

```yaml
rules:
  # Production orgs receive all configuration updates for compliance
  - name: production-full-sync
    org_targets:
      include: ["prod-*"]
    
  # Test orgs get limited updates to prevent accidental changes
  - name: test-limited-sync
    org_targets:
      include: ["test-*"]
    files_to_sync:
      exclude: ["repos/prod-*.yml"]  # Don't sync prod repos to test
```

### 4. Test with Disabled Rules First

```yaml
rules:
  # Testing new exclusion pattern - not active yet
  - name: experimental-filtering
    enabled: false  # Safe to test without affecting production
    org_targets:
      include: ["test-org"]
    files_to_sync:
      exclude: ["draft-*.yml"]
```

Once verified, set `enabled: true`

### 5. Keep Reference Files in Hub

Files can exist in hub without syncing - perfect for:
- Documentation: `organizations/org-1/README.md`
- Drafts: `organizations/org-1/draft-settings.yml`
- Templates: `organizations/template-org/settings.yml`

Just exclude them in manifest:
```yaml
files_to_sync:
  exclude:
    - "README.md"
    - "draft-*.yml"
```

---

## Real-World Examples

### Example 1: Phased Rollout

**Scenario**: Rolling out new configuration to orgs in phases

```yaml
# Phase 1: Pilot orgs only
rules:
  - name: phase-1-pilot
    enabled: true
    org_targets:
      include:
        - "pilot-org-1"
        - "pilot-org-2"
    files_to_sync:
      include: ["settings.yml"]
    mergeStrategy: merge
```

After validation, update to Phase 2:
```yaml
# Phase 2: Add production orgs
rules:
  - name: phase-2-production
    enabled: true
    org_targets:
      include:
        - "pilot-org-1"
        - "pilot-org-2"
        - "prod-*"           # Added production orgs
    files_to_sync:
      include: ["settings.yml"]
    mergeStrategy: merge
```

### Example 2: Regional Distribution

**Scenario**: Different suborg configs for different regions based on geographic teams

You have in `globals/suborgs/`:
- `us-east.yml`, `us-west.yml` - US region teams
- `eu-west.yml`, `eu-north.yml` - EU region teams
- `common.yml` - Shared across all regions

```yaml
rules:
  # US orgs get US suborg configs
  - name: us-region
    org_targets:
      include: ["org-us-*"]
    files_to_sync:
      include:
        - "settings.yml"
        - "suborgs/us-*.yml"      # All US suborg configs
        - "suborgs/common.yml"     # Common suborg config
      exclude:
        - "suborgs/eu-*.yml"       # No EU configs
    mergeStrategy: merge
  
  # EU orgs get EU suborg configs
  - name: eu-region
    org_targets:
      include: ["org-eu-*"]
    files_to_sync:
      include:
        - "settings.yml"
        - "suborgs/eu-*.yml"       # All EU suborg configs
        - "suborgs/common.yml"     # Common suborg config
      exclude:
        - "suborgs/us-*.yml"       # No US configs
    mergeStrategy: merge
```

**Distribution Table**:

| File Changed | org-us-east | org-us-west | org-eu-west | org-eu-north |
|--------------|-------------|-------------|-------------|--------------|
| `globals/suborgs/us-east.yml` | ✅ Synced | ✅ Synced | ❌ Excluded | ❌ Excluded |
| `globals/suborgs/us-west.yml` | ✅ Synced | ✅ Synced | ❌ Excluded | ❌ Excluded |
| `globals/suborgs/eu-west.yml` | ❌ Excluded | ❌ Excluded | ✅ Synced | ✅ Synced |
| `globals/suborgs/eu-north.yml` | ❌ Excluded | ❌ Excluded | ✅ Synced | ✅ Synced |
| `globals/suborgs/common.yml` | ✅ Synced | ✅ Synced | ✅ Synced | ✅ Synced |

**Key Benefit**: Regional compliance and data sovereignty - EU teams don't receive US configurations and vice versa.

### Example 3: Compliance Separation

**Scenario**: Compliance-critical orgs get vetted configs only

```yaml
rules:
  # Compliance orgs - strict filtering
  - name: compliance-orgs
    org_targets:
      include: ["compliance-*", "audit-*"]
    files_to_sync:
      include:
        - "settings.yml"      # Only approved configs
      exclude:
        - "repos/*"           # No repo configs
        - "suborgs/*"         # No suborg configs
        - "experimental-*"    # No experimental configs
    mergeStrategy: overwrite  # Force exact configuration
  
  # Dev orgs - everything allowed
  - name: dev-orgs
    org_targets:
      include: ["dev-*"]
    files_to_sync:
      include: ["*.yml"]      # All files
    mergeStrategy: merge
```

### Example 4: Selective Suborg Deployment

**Scenario**: You create a new suborg config for a DevOps team and want to roll it out selectively

**Step 1**: Create the new suborg config
```bash
# Create new DevOps suborg configuration
touch .github/safe-settings/globals/suborgs/devops-platform.yml
```

**Step 2**: Configure selective distribution in manifest
```yaml
rules:
  # Production orgs with DevOps teams
  - name: prod-orgs-with-devops
    org_targets:
      include:
        - "org-prod-main"
        - "org-prod-platform"
        - "org-prod-services"
    files_to_sync:
      include:
        - "settings.yml"
        - "suborgs/devops-platform.yml"  # Only the new DevOps config
        - "suborgs/backend.yml"          # Existing backend config
        - "suborgs/frontend.yml"         # Existing frontend config
    mergeStrategy: merge
  
  # Dev/Test orgs - exclude the new DevOps suborg (not ready yet)
  - name: dev-test-orgs
    org_targets:
      include:
        - "org-dev-*"
        - "org-test-*"
    files_to_sync:
      include:
        - "settings.yml"
        - "suborgs/*.yml"
      exclude:
        - "suborgs/devops-platform.yml"  # Exclude DevOps from dev/test
    mergeStrategy: merge
```

**Step 3**: Push changes
```bash
git add .github/safe-settings/globals/suborgs/devops-platform.yml
git commit -m "Add DevOps platform suborg configuration"
git push
```

**Result Distribution**:

| Organization | Receives devops-platform.yml? | Reason |
|--------------|-------------------------------|--------|
| org-prod-main | ✅ Yes | Explicitly included in prod rule |
| org-prod-platform | ✅ Yes | Explicitly included in prod rule |
| org-prod-services | ✅ Yes | Explicitly included in prod rule |
| org-dev-sandbox | ❌ No | Excluded by dev-test rule |
| org-test-qa | ❌ No | Excluded by dev-test rule |

**Key Benefit**: New suborg configurations can be tested in production orgs first before rolling out to dev/test environments.

---

## Related Documentation

- [ADR: Organization and File Selective Synchronization](./ADR-org-file-selective-sync.md) - Design decision and architecture
- [ADR: Manifest-Based Hub-Sync Control](./ADR-manifest-control.md) - Original manifest design
- [Hub-Sync Architecture](./architecture-sequence.md) - Overall sync flow
- [Implementation Summary](./IMPLEMENTATION-SUMMARY.md) - Technical details

---

## Quick Reference

### Manifest Structure

```yaml
rules:
  - name: <rule-name>
    enabled: true|false
    org_targets:
      include: [patterns]
      exclude: [patterns]
    files_to_sync:
      include: [patterns]
      exclude: [patterns]
    mergeStrategy: merge|overwrite|preserve
```

### Common Patterns

| Pattern | Matches | Example |
|---------|---------|---------|
| `*` | Any characters | `test-*` → `test-org`, `test-123` |
| `*.yml` | Any .yml file | `settings.yml`, `config.yml` |
| `repos/*.yml` | .yml in repos/ | `repos/api.yml` |
| `suborgs/*.yml` | .yml in suborgs/ | `suborgs/backend.yml`, `suborgs/frontend.yml` |
| `suborgs/us-*.yml` | US suborgs | `suborgs/us-east.yml`, `suborgs/us-west.yml` |
| `suborgs/eu-*.yml` | EU suborgs | `suborgs/eu-west.yml`, `suborgs/eu-north.yml` |
| `test-?` | Single char | `test-1`, `test-a` |
| Literal | Exact match | `"org-1"` → only `org-1` |

### Rule Precedence Quick Reference

**How Rules Work**:
- ✅ **OR logic** - ANY rule can include an org/file
- 🔢 **Order matters** - Rules evaluated top-to-bottom
- 🏆 **First match wins** - First rule to include returns TRUE immediately
- 🚫 **Within rule** - Exclude checked before include
- ➡️ **Exclude continues** - If excluded by one rule, checks next rule
- ❌ **No match = excluded** - Default is to exclude if no rule includes

**Key Rules**:
1. Put **specific** rules BEFORE general rules
2. An exclude in one rule doesn't prevent another rule from including
3. To truly block something, ensure NO rule includes it
4. Use clear rule names for debugging

**Quick Test**: "Does file X sync to org Y?"
1. Check rules in order (top to bottom)
2. For each rule: Is rule enabled? → Does org match include (and not exclude)? → Does file match include (and not exclude)?
3. If YES to all → **SYNCS** (stop checking)
4. If NO to any → Try next rule
5. If no rule matches → **EXCLUDED**

### Merge Strategies

- **merge**: Create PR with changes (safe, reviewable)
- **overwrite**: Direct push, replace all content (fast, no review)
- **preserve**: Only add new files, never update existing

---

**Questions?** Check the [Troubleshooting](#troubleshooting) section or review the logs for detailed pattern matching information.
