# ADR: Manifest-Based Hub-Sync Control with Include/Exclude Rules

**Status:** ✅ Implemented  
**Date Created:** 2026-07-07  
**Date Implemented:** 2026-07-07

## Context and Problem Statement

The current hub-sync manifest (`globals/manifest.yml`) uses a simple rules-based structure with basic target organization selection. Users need more fine-grained control over:
1. Which organizations participate in hub-sync operations (blast radius control)
2. Which files/patterns should be synchronized from the master config repo
3. Ability to exclude specific organizations or file patterns from synchronization

Current limitations:
- Cannot easily exclude specific organizations from receiving updates
- Cannot exclude specific file patterns (e.g., repos/*, suborgs/*) from syncing
- Users must manually manage which files exist vs. which should sync
- No clear way to quarantine test/admin organizations from production syncs

## Decision Drivers

- **Safety**: Prevent accidental configuration pushes to production/sensitive orgs
- **Flexibility**: Support different sync strategies for different org/file combinations
- **Clarity**: Make it obvious which orgs and files are managed by hub-sync
- **Backward Compatibility**: Existing manifest configurations should continue to work
- **Simplicity**: Users should be able to understand and configure the manifest easily

## Considered Options

### Option 1: Manifest Controls Globals Only
- Manifest only controls distribution of `globals/` files
- Organization-specific changes (`organizations/{org}/`) always sync to their respective org
- Simple but limited blast radius control

### Option 2: Manifest Controls Everything (CHOSEN)
- Manifest controls ALL hub-sync operations (both globals/ and organizations/)
- Organizations not in `org_targets` receive NO hub-sync updates
- Files not matching `files_to_sync` patterns are never synchronized
- Full blast radius control at both org and file level

### Option 3: Per-Rule Include/Exclude Within Existing Structure
- Keep current rules structure, add include/exclude within each rule
- More complex but allows multiple policies (e.g., prod vs dev rules)

## Decision Outcome

**Chosen option: Option 2 - Manifest Controls Everything**

The manifest acts as the master control for all hub-sync operations, providing comprehensive blast radius control.

### Manifest Schema

```yaml
rules:
  - name: global-defaults
    org_targets:
      include:
        - "*"              # All organizations
      exclude:
        - magh-admin       # Admin org excluded
        - test-*           # Test orgs excluded
    
    files_to_sync:
      include:
        - "*.yml"          # All YAML files
      exclude:
        - repos/*          # No repo configs
        - suborgs/*        # No suborg configs
    
    mergeStrategy: merge   # merge | overwrite | preserve
    enabled: true

  - name: security-baseline
    org_targets:
      include:
        - prod-*
    files_to_sync:
      include:
        - settings.yml
    mergeStrategy: overwrite
```

### Behavior Examples

| Scenario | File Changed | Manifest Rule | Result |
|----------|-------------|---------------|---------|
| 1 | `globals/settings.yml` | Org: all except test-*, File: *.yml included | Syncs to prod orgs only |
| 2 | `globals/repos/common.yml` | File: repos/* excluded | NO SYNC (pattern excluded) |
| 3 | `organizations/test-org/settings.yml` | Org: test-* excluded | NO SYNC (org excluded) |
| 4 | `organizations/prod-org/settings.yml` | Org: prod-* included, File: *.yml included | Syncs to prod-org |
| 5 | `organizations/prod-org/repos/repo.yml` | File: repos/* excluded | NO SYNC (pattern excluded) |

### Positive Consequences

- **Full Control**: Organizations can be completely quarantined from hub-sync
- **File-Level Safety**: Dangerous file patterns can be excluded globally
- **Clear Boundaries**: Explicit include/exclude makes intent obvious
- **Flexibility**: Multiple rules support different policies
- **Non-Managed Files**: Files can exist in repo for reference without triggering sync

### Negative Consequences

- **Breaking Change**: Org-specific files can now be blocked by manifest (previously always synced)
- **Complexity**: Users must understand both org and file filtering
- **Migration**: Existing manifests may need updates to work as expected
- **Surprising Behavior**: Editing `organizations/my-org/settings.yml` might not sync if org is excluded

## Implementation Notes

### Key Changes Required

1. **Manifest Loading** (`hubSyncHandler.js`):
   - Add `loadManifest(context, ref)` function
   - Parse and validate manifest structure
   - Cache manifest for performance

2. **Pattern Matching**:
   - Use `minimatch` library for glob pattern matching
   - Support wildcards: `*`, `test-*`, `*/repos/*`

3. **Filtering Logic**:
   - Apply org filtering in `syncHubGlobalsUpdate` and `syncHubOrgUpdate`
   - Apply file filtering before creating commits
   - Short-circuit sync if org or file is excluded

4. **PR Validation Enhancement** (`validateAndReportHubSync`):
   - Show which orgs will receive updates based on manifest
   - Warn if changed files are excluded by manifest
   - Display filtered org list in PR comment

5. **Manifest Validation**:
   - Validate manifest YAML syntax in PRs
   - Check for valid include/exclude structure
   - Warn about conflicting rules

### Backward Compatibility Strategy

Support both old and new manifest formats:

**Old Format (still supported):**
```yaml
rules:
  - name: global-defaults
    targets:
      - "*"
    files:
      - "*.yml"
```

**New Format:**
```yaml
rules:
  - name: global-defaults
    org_targets:
      include:
        - "*"
    files_to_sync:
      include:
        - "*.yml"
```

**Migration Logic:**
- If `org_targets` exists, use new format
- If only `targets` exists, convert to `org_targets.include`
- Default behavior without manifest: sync everything (backward compatible)

## Links

- Related Documentation: [docs/hubSyncHandler/README.md](./README.md)
- Use Case: [docs/hubSyncHandler/usecase-merge-behavior.md](./usecase-merge-behavior.md)
- Implementation: [lib/hubSyncHandler.js](../../lib/hubSyncHandler.js)

---

**Status**: ✅ Implemented  
**Date**: 2026-07-07  
**Author**: Safe-Settings Team  
**Decision**: Manifest-based hub-sync control with include/exclude rules for organizations and files
