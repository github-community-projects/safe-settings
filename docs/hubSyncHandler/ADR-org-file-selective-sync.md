# ADR: Organization and File Selective Synchronization

**Status:** ✅ Implemented  
**Date Created:** 2026-07-08  
**Related ADR:** [ADR-manifest-control.md](./ADR-manifest-control.md)

## Context and Problem Statement

Hub-Sync needs fine-grained control over:
1. **Which organizations** should participate in synchronization operations
2. **Which files** should be synchronized per organization
3. **Mixed policies** where different orgs have different sync rules

### Real-World Use Cases

**Use Case 1: Organization-Level Control**
- ORG-1, ORG-2, ORG-3 should receive sync updates
- ORG-4 should NOT receive any sync updates (excluded)

**Use Case 2: File-Level Control Per Organization**
- ORG-1: Include `settings.yml` for syncing
- ORG-2: Include `settings.yml` for syncing
- ORG-3: Exclude `settings.yml` from syncing (other files still sync)

**Use Case 3: Quarantine/Test Organizations**
- Production orgs receive all updates
- Test/staging orgs excluded from automatic syncs
- Admin orgs excluded completely

**Use Case 4: Phased Rollouts**
- Phase 1: Sync to pilot orgs only
- Phase 2: Add production orgs
- Phase 3: Include all remaining orgs

## Decision

The manifest.yml `rules` array provides the solution through **include/exclude patterns** for both organizations and files. Multiple rules can be defined, and orgs/files are synced if they match ANY enabled rule.

## Solution Architecture

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

### Matching Logic

1. **Organization Matching**:
   - Org must match at least one rule's `org_targets.include` pattern
   - If org matches any `org_targets.exclude` pattern in that rule, it's skipped
   - If no rules match the org, sync is skipped

2. **File Matching**:
   - File must match at least one rule's `files_to_sync.include` pattern
   - If file matches any `files_to_sync.exclude` pattern in that rule, it's skipped
   - If no rules match the file, sync is skipped

3. **Pattern Syntax**: Uses `minimatch` glob patterns
   - `*` = wildcard (e.g., `test-*` matches `test-org1`, `test-org2`)
   - `**` = recursive wildcard
   - `?` = single character
   - Literal strings also supported

## Globals/ Distribution Concept

The **globals/ folder** contains configuration files that are **distributed from the hub to multiple organizations**. This is the core "hub-and-spoke" pattern where:

- **One file → Many orgs**: A single file in `globals/` (e.g., `globals/suborgs/common.yml`) is pushed to multiple organization repositories
- **Manifest controls distribution**: The manifest determines WHICH orgs receive WHICH files
- **Centralized management**: Update once in hub, distribute to many orgs automatically

### How It Works

```
Hub Repo (safe-settings-config-master)
└── .github/safe-settings/
    ├── globals/
    │   ├── settings.yml          → Distributed to filtered orgs
    │   ├── suborgs/
    │   │   ├── common.yml        → Distributed to filtered orgs
    │   │   ├── us-east.yml       → Distributed to filtered orgs
    │   │   └── eu-west.yml       → Distributed to filtered orgs
    │   └── manifest.yml          (Controls distribution rules)
    └── organizations/
        ├── org-1/                (Org-specific overrides)
        └── org-2/

When globals/suborgs/common.yml changes:
1. syncHubGlobalsUpdate() loads manifest
2. Filters orgs: org-1, org-2, org-3 (based on manifest rules)
3. Filters files: suborgs/common.yml (based on manifest rules)
4. Distributes: Pushes file to org-1, org-2, org-3 admin repos
```

### Example: Globals/Suborgs Distribution

**Scenario**: You have suborg configurations in `globals/suborgs/` that need to be distributed to different organizations based on region.

**manifest.yml:**
```yaml
rules:
  # US organizations get US suborg configs
  - name: us-region-suborgs
    enabled: true
    org_targets:
      include:
        - "org-us-*"        # All US orgs
        - "customer-us-*"
    files_to_sync:
      include:
        - "settings.yml"
        - "suborgs/us-*.yml"     # Only US suborg files
        - "suborgs/common.yml"   # Common suborg config
      exclude:
        - "suborgs/eu-*.yml"     # No EU files
    mergeStrategy: merge
  
  # EU organizations get EU suborg configs
  - name: eu-region-suborgs
    enabled: true
    org_targets:
      include:
        - "org-eu-*"        # All EU orgs
        - "customer-eu-*"
    files_to_sync:
      include:
        - "settings.yml"
        - "suborgs/eu-*.yml"     # Only EU suborg files
        - "suborgs/common.yml"   # Common suborg config
      exclude:
        - "suborgs/us-*.yml"     # No US files
    mergeStrategy: merge
  
  # Admin organizations get ALL suborg configs
  - name: admin-all-regions
    enabled: true
    org_targets:
      include:
        - "admin-*"
    files_to_sync:
      include:
        - "suborgs/*.yml"   # All suborg files
        - "*.yml"           # All YAML files
    mergeStrategy: merge
```

**Distribution Table:**

| File Changed | US Orgs (org-us-*) | EU Orgs (org-eu-*) | Admin Orgs (admin-*) |
|--------------|--------------------|--------------------|----------------------|
| `globals/suborgs/common.yml` | ✅ Distributed | ✅ Distributed | ✅ Distributed |
| `globals/suborgs/us-east.yml` | ✅ Distributed | ❌ Excluded | ✅ Distributed |
| `globals/suborgs/us-west.yml` | ✅ Distributed | ❌ Excluded | ✅ Distributed |
| `globals/suborgs/eu-west.yml` | ❌ Excluded | ✅ Distributed | ✅ Distributed |
| `globals/suborgs/eu-north.yml` | ❌ Excluded | ✅ Distributed | ✅ Distributed |
| `globals/settings.yml` | ✅ Distributed | ✅ Distributed | ✅ Distributed |

**Key Point**: When you edit `globals/suborgs/us-east.yml`, it automatically gets pushed to:
- ✅ All `org-us-*` organizations
- ✅ All `admin-*` organizations  
- ❌ NOT to `org-eu-*` organizations (excluded by manifest)

### Code Flow for Globals Distribution

```javascript
// lib/hubSyncHandler.js - Line 644
async function syncHubGlobalsUpdate(robot, context, files) {
  // 1. Load manifest
  const manifest = await loadManifest(context.octokit, prHeadSha, robot.log)
  
  // 2. Get all organizations with installations
  const allOrgLogins = installs
    .filter(i => i.account && i.account.type === 'Organization')
    .map(i => i.account.login)
  
  // 3. Filter orgs by manifest (Line 667)
  const filteredOrgLogins = filterOrgsByManifest(allOrgLogins, manifest, robot.log)
  //    Example: ["org-us-east", "org-us-west", "admin-prod"]
  
  // 4. For each changed file in globals/
  for (const fileObj of changedGlobals) {
    const fileName = fileObj.filename.split('/').pop()
    
    // 5. Check if file should be synced (Line 680)
    if (!matchesFilesToSync(fileName, manifest, robot.log)) {
      continue  // Skip this file
    }
    
    // 6. Distribute file to ALL filtered orgs (Line 833+)
    for (const orgName of filteredOrgLogins) {
      // Push file to orgName/.github-admin/
      await githubDest.repos.createOrUpdateFileContents({
        owner: orgName,
        repo: destRepo,
        path: destPath,
        content: fileContent,
        // ...
      })
    }
  }
}
```

**Example execution:**
```
Change: globals/suborgs/us-east.yml

Step 1: Load manifest → Rules loaded
Step 2: Get all orgs → ["org-us-east", "org-us-west", "org-eu-north", "admin-prod"]
Step 3: Filter by manifest → ["org-us-east", "org-us-west", "admin-prod"]
        (org-eu-north excluded - doesn't match us-region-suborgs rule)
Step 4: Check file pattern → "suborgs/us-east.yml" matches "suborgs/us-*.yml"
Step 5: Distribute to:
        ✅ org-us-east/.github-admin/suborgs/us-east.yml
        ✅ org-us-west/.github-admin/suborgs/us-east.yml
        ✅ admin-prod/.github-admin/suborgs/us-east.yml
```

## Globals/ vs Organizations/ Syncing

There are two distinct sync patterns in Safe-Settings hub-sync:

### Pattern 1: Globals/ Distribution (One-to-Many)
- **Source**: `hub/globals/` folder
- **Destination**: Multiple organization repos
- **Purpose**: Share common configuration across many orgs
- **Example**: `globals/suborgs/common.yml` → distributed to org-1, org-2, org-3
- **Control**: Manifest `org_targets` determines which orgs receive the file

```
Hub: globals/suborgs/common.yml
  ├─→ org-us-east/.github-admin/suborgs/common.yml
  ├─→ org-us-west/.github-admin/suborgs/common.yml
  └─→ admin-prod/.github-admin/suborgs/common.yml
```

### Pattern 2: Organizations/ Sync (One-to-One)
- **Source**: `hub/organizations/{org-name}/` folder
- **Destination**: Specific organization repo (matching folder name)
- **Purpose**: Org-specific overrides or configurations
- **Example**: `organizations/org-us-east/settings.yml` → only org-us-east
- **Control**: Manifest `org_targets` can still exclude the org entirely

```
Hub: organizations/org-us-east/settings.yml
  └─→ org-us-east/.github-admin/settings.yml (only this org)
```

### Combined Example

**Hub Structure:**
```
.github/safe-settings/
├── globals/
│   ├── settings.yml              (Base settings - distributed to all)
│   └── suborgs/
│       ├── common.yml            (Common suborgs - distributed to all)
│       └── us-east.yml           (US-specific - distributed to US orgs)
└── organizations/
    └── org-us-prod/
        └── settings.yml          (Override for org-us-prod only)
```

**What each org receives:**

| Organization | Files Received | Source |
|-------------|----------------|---------|
| org-us-east | settings.yml | Merge of globals/ + no org-specific override |
| | suborgs/common.yml | globals/ distribution |
| | suborgs/us-east.yml | globals/ distribution |
| org-us-prod | settings.yml | Merge of globals/ + organizations/org-us-prod/ |
| | suborgs/common.yml | globals/ distribution |
| | suborgs/us-east.yml | globals/ distribution |
| org-eu-west | settings.yml | Merge of globals/ + no org-specific override |
| | suborgs/common.yml | globals/ distribution |
| | ❌ suborgs/us-east.yml | NOT distributed (excluded by manifest) |

**Key Insight**: 
- **globals/** = "Push THIS file to THESE orgs" (manifest controls target orgs)
- **organizations/** = "Push THESE files to THIS org" (folder name = target org)

## Implementation Examples

### Example 1: Basic Organization Exclusion

**Requirement:**
- ORG-1, ORG-2, ORG-3 included
- ORG-4 excluded

**manifest.yml:**
```yaml
rules:
  - name: selected-orgs-only
    enabled: true
    org_targets:
      include:
        - "ORG-1"
        - "ORG-2"
        - "ORG-3"
      exclude:
        - "ORG-4"
    files_to_sync:
      include:
        - "*.yml"
    mergeStrategy: merge
```

**Alternative with wildcards:**
```yaml
rules:
  - name: all-except-org4
    enabled: true
    org_targets:
      include:
        - "*"           # All orgs
      exclude:
        - "ORG-4"       # Except ORG-4
    files_to_sync:
      include:
        - "*.yml"
    mergeStrategy: merge
```

### Example 2: Per-Organization File Exclusion

**Requirement:**
- ORG-1: Include settings.yml
- ORG-2: Include settings.yml
- ORG-3: Exclude settings.yml (but sync other files)

**manifest.yml:**
```yaml
rules:
  # Rule 1: ORG-1 and ORG-2 get settings.yml
  - name: org1-and-org2-full-sync
    enabled: true
    org_targets:
      include:
        - "ORG-1"
        - "ORG-2"
    files_to_sync:
      include:
        - "*.yml"       # All YAML files including settings.yml
    mergeStrategy: merge
  
  # Rule 2: ORG-3 gets everything EXCEPT settings.yml
  - name: org3-without-settings
    enabled: true
    org_targets:
      include:
        - "ORG-3"
    files_to_sync:
      include:
        - "*.yml"       # All YAML files
      exclude:
        - "settings.yml" # Except settings.yml
    mergeStrategy: merge
```

### Example 3: Production vs Test Separation

**Requirement:**
- Production orgs: Sync everything
- Test orgs: Sync only specific files
- Admin orgs: No sync at all

**manifest.yml:**
```yaml
rules:
  # Rule 1: Production orgs get all files
  - name: production-full-sync
    enabled: true
    org_targets:
      include:
        - "prod-*"
        - "customer-*"
      exclude:
        - "*-test"
        - "*-admin"
    files_to_sync:
      include:
        - "*.yml"
    mergeStrategy: merge
  
  # Rule 2: Test orgs get limited files
  - name: test-limited-sync
    enabled: true
    org_targets:
      include:
        - "*-test"
        - "sandbox-*"
    files_to_sync:
      include:
        - "settings.yml"
        - "repos/test-*.yml"
      exclude:
        - "repos/prod-*.yml"
    mergeStrategy: preserve
  
  # Rule 3: Admin orgs are implicitly excluded (no rule matches them)
  # No rule needed - they won't match any org_targets
```

### Example 4: Phased Rollout Strategy

**Phase 1: Pilot orgs only**
```yaml
rules:
  - name: phase-1-pilot
    enabled: true
    org_targets:
      include:
        - "pilot-org-1"
        - "pilot-org-2"
    files_to_sync:
      include:
        - "*.yml"
    mergeStrategy: merge
```

**Phase 2: Add production orgs** (modify existing rule)
```yaml
rules:
  - name: phase-2-production
    enabled: true
    org_targets:
      include:
        - "pilot-org-1"
        - "pilot-org-2"
        - "prod-*"      # Added production orgs
    files_to_sync:
      include:
        - "*.yml"
    mergeStrategy: merge
```

**Phase 3: Include all except admin** (modify existing rule)
```yaml
rules:
  - name: phase-3-all-orgs
    enabled: true
    org_targets:
      include:
        - "*"           # All orgs
      exclude:
        - "*-admin"     # Except admin orgs
    files_to_sync:
      include:
        - "*.yml"
    mergeStrategy: merge
```

## Behavior Matrix

| Org | Rule Match | File | Rule Match | Result |
|-----|-----------|------|-----------|---------|
| ORG-1 | Include in rule-1 | settings.yml | Include in rule-1 | ✅ SYNC |
| ORG-2 | Include in rule-1 | settings.yml | Include in rule-1 | ✅ SYNC |
| ORG-3 | Include in rule-2 | settings.yml | Exclude in rule-2 | ❌ SKIP |
| ORG-3 | Include in rule-2 | repos/common.yml | Include in rule-2 | ✅ SYNC |
| ORG-4 | Exclude in rule-1 | settings.yml | Include in rule-1 | ❌ SKIP (org excluded) |
| test-org | No match | settings.yml | N/A | ❌ SKIP (no rule matches) |

## Testing Scenarios

### Scenario 1: Organization Included, File Excluded
```yaml
rules:
  - name: test-rule
    org_targets:
      include: ["test-org"]
    files_to_sync:
      include: ["*.yml"]
      exclude: ["settings.yml"]
```
- Hub change: `organizations/test-org/settings.yml`
- **Result**: ❌ SKIP (file excluded despite org match)

### Scenario 2: Organization Excluded, File Included
```yaml
rules:
  - name: test-rule
    org_targets:
      include: ["prod-*"]
      exclude: ["prod-admin"]
    files_to_sync:
      include: ["*.yml"]
```
- Hub change: `organizations/prod-admin/settings.yml`
- **Result**: ❌ SKIP (org excluded despite file match)

### Scenario 3: Multiple Rules, One Matches
```yaml
rules:
  - name: rule-1
    org_targets:
      include: ["org-1"]
    files_to_sync:
      include: ["settings.yml"]
  
  - name: rule-2
    org_targets:
      include: ["org-2"]
    files_to_sync:
      include: ["repos/*.yml"]
```
- Hub change: `organizations/org-2/repos/common.yml`
- **Result**: ✅ SYNC (matches rule-2)

### Scenario 4: No Rules Match
```yaml
rules:
  - name: only-prod
    org_targets:
      include: ["prod-*"]
    files_to_sync:
      include: ["*.yml"]
```
- Hub change: `organizations/test-org/settings.yml`
- **Result**: ❌ SKIP (no rule matches org "test-org")

## Implementation Details

### Code Location
- **Manifest Loading**: `lib/hubSyncHandler.js` - `loadManifest()`
- **Org Matching**: `lib/hubSyncHandler.js` - `matchesOrgTargets()`
- **File Matching**: `lib/hubSyncHandler.js` - `matchesFilesToSync()`
- **Normalization**: `lib/hubSyncHandler.js` - `normalizeManifestRules()`

### Functions

```javascript
// Check if org should be synced
function matchesOrgTargets(orgName, manifest, logger) {
  // Returns true if ANY rule includes the org
  // Returns false if org is excluded or no rules match
}

// Check if file should be synced
function matchesFilesToSync(filePath, manifest, logger) {
  // Returns true if ANY rule includes the file
  // Returns false if file is excluded or no rules match
}
```

### Caching
- Manifest is cached for 1 minute (60 seconds)
- Cache key: manifest content hash
- Cache invalidated on manifest.yml changes

## Migration from Existing Setup

### Current State (No Manifest)
- All orgs receive all file changes
- No filtering or exclusion capability

### Migration Path

**Step 1: Create basic manifest** (no behavior change)
```yaml
rules:
  - name: all-orgs-all-files
    org_targets:
      include: ["*"]
    files_to_sync:
      include: ["*.yml"]
    mergeStrategy: merge
```

**Step 2: Add exclusions incrementally**
```yaml
rules:
  - name: all-except-test
    org_targets:
      include: ["*"]
      exclude: ["*-test", "*-admin"]  # Added exclusions
    files_to_sync:
      include: ["*.yml"]
    mergeStrategy: merge
```

**Step 3: Add per-org file rules**
```yaml
rules:
  - name: production-full-sync
    org_targets:
      include: ["prod-*"]
    files_to_sync:
      include: ["*.yml"]
    mergeStrategy: merge
  
  - name: test-limited-sync
    org_targets:
      include: ["*-test"]
    files_to_sync:
      include: ["settings.yml"]  # Only settings.yml for test
      exclude: ["repos/*"]
    mergeStrategy: preserve
```

## Troubleshooting

### Issue: Org not receiving syncs

**Diagnostic Steps:**
1. Check if org matches any `org_targets.include` pattern
2. Verify org is not in any `org_targets.exclude` list
3. Ensure at least one rule has `enabled: true`
4. Check logs for "Org {name} not matched by any manifest rule"

### Issue: File not syncing to org

**Diagnostic Steps:**
1. Check if file matches any `files_to_sync.include` pattern
2. Verify file is not in any `files_to_sync.exclude` list
3. Check both org AND file rules (both must match)
4. Check logs for "File {path} not matched by any manifest rule"

### Issue: Unexpected sync behavior

**Debugging:**
```yaml
# Enable debug logging to see rule matching
rules:
  - name: debug-rule
    enabled: true
    org_targets:
      include: ["*"]
    files_to_sync:
      include: ["*.yml"]
```
- Check logs for: "Org {name} included by rule '{rule-name}'"
- Check logs for: "File {path} included by rule '{rule-name}'"

## Best Practices

1. **Start Broad, Refine Incrementally**
   - Begin with `include: ["*"]`
   - Add `exclude` patterns as needed

2. **Use Descriptive Rule Names**
   - ✅ `production-orgs-only`
   - ❌ `rule-1`

3. **Document Intent in Comments**
   ```yaml
   rules:
     # Production orgs get all updates for compliance
     - name: production-full-sync
       org_targets:
         include: ["prod-*"]
   ```

4. **Test with Disabled Rules First**
   ```yaml
   rules:
     - name: experimental-rule
       enabled: false  # Test rule, not active yet
   ```

5. **Use Multiple Rules for Complex Logic**
   - Separate concerns (prod vs test vs admin)
   - Easier to understand and maintain
   - Clear intent for each rule

6. **Prefer Explicit Over Implicit**
   - ✅ Explicit exclude list
   - ❌ Relying on "no match" behavior

## Positive Consequences

- **Precise Control**: Org and file level filtering
- **Safety**: Prevent accidental syncs to sensitive orgs
- **Flexibility**: Different rules for different scenarios
- **Visibility**: Clear declaration of sync policy
- **Testability**: Easy to predict behavior from manifest

## Negative Consequences

- **Complexity**: More configuration to manage
- **Hidden Behavior**: Files exist but don't sync (surprising)
- **Maintenance**: Must keep manifest updated as orgs change
- **Learning Curve**: Users must understand pattern matching

## Related Documentation

- [Manifest Control ADR](./ADR-manifest-control.md) - Original design decision
- [Hub-Sync Architecture](./architecture-sequence.md) - Overall flow
- [Manifest Reference](./README.md#manifest-yml-reference) - Detailed syntax
- [Implementation Summary](./IMPLEMENTATION-SUMMARY.md) - Code details

---

**Status**: Implemented  
**Date**: 2026-07-08  
**Author**: Safe-Settings Team  
**Decision**: Organization and file selective synchronization via manifest include/exclude patterns
