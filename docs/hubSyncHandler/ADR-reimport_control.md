# ADR: Reimport Control for Hub-Sync Organization Retrieval

**Status:** Proposed  
**Date Created:** 2026-07-08  
**Related Function:** `retrieveSettingsFromOrgs()`  
**Environment Variable:** `SAFE_SETTINGS_HUB_REIMPORT`

## Context and Problem Statement

The `retrieveSettingsFromOrgs()` function imports organization settings from individual org admin repositories into the hub-sync master repository. Currently, it has limited control over when imports occur:

**Current Behavior:**
- Checks if `organizations/<orgName>/` folder exists in hub repo
- **Skips** import if folder exists AND has at least one file
- **Proceeds** with import if folder doesn't exist OR is empty

**Limitations:**
1. **Partial imports cannot be fixed** - If someone manually creates the folder with only some files, or if an import fails partway through, subsequent attempts are blocked
2. **No update mechanism** - If an organization updates their configuration files, there's no way to re-import the updated content
3. **No reimport control** - Cannot refresh hub content from source of truth (org repos) after initial import
4. **Single behavior mode** - All deployments have the same (safe) behavior with no flexibility

## Decision Drivers

1. **Safety first** - Default behavior should prevent accidental overwrites in production
2. **Flexibility needed** - Some scenarios require force-updating or completing partial imports
3. **Operational clarity** - Different environments may need different behaviors (dev vs prod)
4. **Backward compatibility** - Existing deployments should not change behavior

## Considered Options

### Option 1: Add `allowReimport` function parameter
```javascript
retrieveSettingsFromOrgs(robot, orgNames, { allowReimport: true })
```

**Pros:**
- Explicit control at call site
- Can be conditional per invocation

**Cons:**
- Requires code changes to use
- No configuration at deployment level
- API callers must handle the flag

### Option 2: Environment variable `SAFE_SETTINGS_HUB_REIMPORT` (Chosen)
```bash
SAFE_SETTINGS_HUB_REIMPORT=false  # Default - only import if nothing exists (safe mode)
SAFE_SETTINGS_HUB_REIMPORT=true   # Allow re-import/updates of existing content
```

**Pros:**
- ✅ Configuration-based, no code changes needed
- ✅ Different behavior per deployment environment
- ✅ Safe default prevents production accidents
- ✅ Backward compatible (defaults to current behavior)
- ✅ Consistent with other hub-sync env vars
- ✅ Intuitive naming - flag describes what it enables (reimporting)

**Cons:**
- Cannot override per-call (acceptable tradeoff)
- Requires restart to change behavior (acceptable)

### Option 3: Manifest-based control per org
```yaml
rules:
  - name: allow-reimport
    org_targets: ["dev-*"]
    reimport_allowed: true
```

**Pros:**
- Granular per-organization control

**Cons:**
- Complex to implement
- Manifest may not exist yet during initial import
- Over-engineered for current needs

## Decision

**Implement Option 2: Environment variable `SAFE_SETTINGS_HUB_REIMPORT`**

### Behavior Matrix

| Scenario | `REIMPORT=false` (default) | `REIMPORT=true` |
|----------|---------------------------|-------------------|
| Folder doesn't exist (404) | ✅ Import | ✅ Import |
| Folder exists but empty (length=0) | ✅ Import | ✅ Import |
| Folder exists with files | ⛔ Skip (safe) | ✅ Re-import/Update |
| Partial/incomplete import | ⛔ Skip (stuck) | ✅ Complete import |
| Files changed in org | ⛔ Skip (stale) | ✅ Refresh from source |

### Default Value

**`REIMPORT=false`** (safe mode)
- Maintains current behavior
- Backward compatible
- Prevents accidental overwrites
- Suitable for production environments

## Implementation Details

### Environment Variable

**Name:** `SAFE_SETTINGS_HUB_REIMPORT`  
**Type:** String (boolean)  
**Valid Values:** `'true'`, `'false'`, `'1'`, `'0'`  
**Default:** `'false'`  
**Location:** `.env` file or deployment configuration

### Code Changes

**File:** `lib/hubSyncHandler.js`  
**Function:** `retrieveSettingsFromOrgs()`  
**Lines to modify:** ~1049-1070 (existence check block)

```javascript
// Read env var (default to 'false' for safe mode - no reimport)
const allowReimport = (env.SAFE_SETTINGS_HUB_REIMPORT || 'false').toLowerCase() === 'true'

// Check existence unless reimport is explicitly enabled
if (!allowReimport) {
  const destOrgPath = `${env.CONFIG_PATH}/${env.SAFE_SETTINGS_HUB_PATH}/organizations/${orgName}`
  try {
    const destCheck = await githubHub.rest.repos.getContent({
      owner: env.SAFE_SETTINGS_HUB_ORG,
      repo: hubRepoName,
      path: destOrgPath,
      ref: baseBranch
    })
    
    if (Array.isArray(destCheck.data) && destCheck.data.length > 0) {
      robot.log.info(`Skipping ${orgName}: already present in hub (REIMPORT=false)`)
      results.push({ org: orgName, status: 'skipped', reason: 'already_imported' })
      continue
    }
  } catch (probeErr) {
    if (!(probeErr && probeErr.status === 404)) {
      // Handle non-404 errors
      robot.log.warn(`Failed to probe hub destination for ${orgName}: ${probeErr.message}`)
      results.push({ org: orgName, error: `failed to check destination: ${probeErr.message}` })
      continue
    }
    // 404 = folder doesn't exist, proceed with import
  }
} else {
  // Reimport mode enabled: always import/update
  robot.log.info(`Re-importing ${orgName}: REIMPORT=true, will update existing files`)
}

// Proceed with import for this org...
```

### Result Status Values

Update result objects to distinguish scenarios:

| Status | Reason | When |
|--------|--------|------|
| `'imported'` | `'first_import'` | New org, folder didn't exist |
| `'imported'` | `'empty_folder'` | Folder existed but was empty |
| `'imported'` | `'reimported'` | REIMPORT=true, updated existing content |
| `'skipped'` | `'already_imported'` | REIMPORT=false, folder has content |
| `'N/A'` | `'admin_repo_not_found'` | Org's admin repo doesn't exist |

### Logging Enhancements

1. **Log mode at function entry:**
   ```javascript
   robot.log.info(`Import mode: REIMPORT=${allowReimport}`)
   ```

2. **Log skip reason clearly:**
   ```javascript
   robot.log.info(`Skipping ${orgName}: already present in hub (REIMPORT=false)`)
   ```

3. **Log reimport:**
   ```javascript
   robot.log.info(`Re-importing ${orgName}: REIMPORT=true, will update existing files`)
   ```

4. **Log file counts:**
   ```javascript
   robot.log.info(`Imported ${treeEntries.length} files for ${orgName} (mode: ${allowReimport ? 'reimport' : 'initial'})`)
   ```

### PR Body Enhancement

When REIMPORT=true and overwriting, update PR body:

```javascript
const prBody = allowReimport
  ? `Automated re-import of settings from ${orgName} admin repo (${adminRepo}) into the hub.
  
**Mode:** REIMPORT=true (reimport enabled)
**Previous import detected:** Files will be updated with current org configuration.`
  : `Automated import of settings from ${orgName} admin repo (${adminRepo}) into the hub.`
```

## Consequences

### Positive

1. **Safe by default** - REIMPORT=false prevents production accidents
2. **Operational flexibility** - Dev/staging can use REIMPORT=true for testing
3. **Recovery from failures** - Partial imports can be completed with REIMPORT=true
4. **Content refresh** - Stale hub content can be updated from org source of truth
5. **Backward compatible** - Existing deployments unchanged
6. **Consistent pattern** - Follows existing hub-sync env var conventions
7. **Intuitive semantics** - Flag name describes what it enables (reimporting), not what it restricts

### Negative

1. **Global setting** - Cannot override per-call (mitigated by being deployment-scoped)
2. **Requires restart** - Env var change needs process restart (acceptable for this use case)
3. **No per-org granularity** - All orgs in a call use the same mode (can be addressed later if needed)
4. **Overwrites without merge** - REIMPORT=true replaces entire tree (intentional, but document clearly)

### Neutral

1. **Additional env var** - Adds to configuration surface (documented in README)
2. **Testing needed** - Requires testing both modes
3. **Documentation updates** - Need to document use cases for each mode

## Use Cases

### Use Case 1: Initial Setup (Production)
```bash
SAFE_SETTINGS_HUB_REIMPORT=false  # Default - can be omitted
```
- Import orgs for the first time
- Safe: won't overwrite if something already exists
- Suitable for production

### Use Case 2: Fix Partial Import (Dev/Ops)
```bash
SAFE_SETTINGS_HUB_REIMPORT=true
```
- Manually created folder with incomplete files
- Previous import failed partway through
- Need to complete the import

### Use Case 3: Refresh Stale Content (Dev/Staging)
```bash
SAFE_SETTINGS_HUB_REIMPORT=true
```
- Organization updated their configuration
- Hub content is out of sync with org repos
- Need to refresh from source of truth

### Use Case 4: Testing Import Logic (Dev)
```bash
SAFE_SETTINGS_HUB_REIMPORT=true
```
- Repeatedly test import process
- No need to manually delete folders between tests
- Faster iteration cycle

## Documentation Updates Needed

1. **README.md** - Add `SAFE_SETTINGS_HUB_REIMPORT` to environment variables section
2. **API docs** - Update `retrieveSettingsFromOrgs` documentation
3. **Deployment guide** - Recommend REIMPORT=false (default) for production
4. **Troubleshooting** - Document using REIMPORT=true to fix partial imports
5. **Example .env** - Include the variable with comment explaining safe default

## Testing Strategy

### Unit Tests

1. Test with `REIMPORT=false` (default):
   - Folder exists with files → skip
   - Folder doesn't exist → import
   - Folder empty → import

2. Test with `REIMPORT=true`:
   - Folder exists with files → re-import
   - Folder doesn't exist → import
   - Folder empty → import

### Integration Tests

1. Import same org twice:
   - First time: should import
   - Second time with REIMPORT=false: should skip
   - Second time with REIMPORT=true: should re-import

2. Verify file updates:
   - Change org repo content
   - Re-import with REIMPORT=true
   - Verify hub reflects new content

## Future Enhancements

1. **Per-org override** - Add `allowReimport` parameter to API for per-call control
2. **Dry-run mode** - Preview what would be imported without creating PR
3. **Incremental update** - Only update changed files instead of full tree replacement
4. **Import audit log** - Track when imports/re-imports occurred
5. **Manifest integration** - Allow manifest to control per-org reimport policy

## References

- Related ADR: [ADR-manifest-control.md](./ADR-manifest-control.md)
- Function: `lib/hubSyncHandler.js:retrieveSettingsFromOrgs()`
- Environment variables: `lib/env.js`
- Existing pattern: `SAFE_SETTINGS_HUB_DIRECT_PUSH`, `SAFE_SETTINGS_HUB_URL_PREFIX`

## Decision Review

- [ ] Review and approve ADR
- [ ] Implement env var parsing
- [ ] Update existence check logic
- [ ] Add logging
- [ ] Update result status values
- [ ] Write unit tests
- [ ] Update documentation
- [ ] Test in dev environment
- [ ] Deploy to production with REIMPORT=false (default)
