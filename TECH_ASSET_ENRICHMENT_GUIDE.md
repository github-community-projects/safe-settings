# Tech Asset Enrichment for Safe-Settings

## Summary

Yes! Safe-settings can react to values in YAML files and enrich them with data from external services. I've created **two approaches** for you:

## Approach 1: Custom Plugin (Integrated) ✨

**Best for:** Organizations that want deep integration with safe-settings

### What I created:

1. **`lib/plugins/tech_asset_enrichment.js`** - A new plugin that:
   - Validates `tech-asset-uuid` against your external service
   - Fetches additional metadata (tag, id, owner, etc.)
   - Enriches the configuration before other plugins run
   - Adds validation error topics when UUIDs are invalid

2. **Modified `lib/settings.js`** to:
   - Register the new plugin
   - Run it BEFORE custom_properties plugin to enrich config

### Pros:
- ✅ Deeply integrated with safe-settings workflow
- ✅ Runs during dry-run PR checks
- ✅ Real-time validation
- ✅ Automatic enrichment every sync
- ✅ Consistent with safe-settings architecture

### Cons:
- ❌ Requires modifying safe-settings core code
- ❌ Need to maintain custom fork or contribute upstream
- ❌ Updates to safe-settings require merge/rebase

### Usage:

```yaml
# .github/repos/my-repo.yml
tech_asset_enrichment:
  service_url: https://tech-asset-api.example.com

custom_properties:
  - name: tech-asset-uuid
    value: "550e8400-e29b-41d4-a716-446655440000"
  # Plugin automatically adds:
  # - tech-asset-tag
  # - tech-asset-id
  # - tech-asset-owner
```

---

## Approach 2: GitHub Actions Pre-Processor (External) 🚀

**Best for:** Organizations that want to avoid forking safe-settings

### What I created:

1. **`.github/workflows/enrich-tech-assets.yml`** - GitHub Actions workflow that:
   - Triggers on YAML file changes
   - Runs BEFORE safe-settings
   - Commits enriched configs back to PR

2. **`.github/scripts/enrich-tech-assets.js`** - Node.js script that:
   - Scans all repo YAML files
   - Fetches tech asset metadata
   - Updates YAML files with enriched properties
   - Generates PR comments with enrichment summary

### Pros:
- ✅ No modification to safe-settings code
- ✅ Works with vanilla safe-settings
- ✅ Easy to update/maintain independently
- ✅ Can be version controlled separately
- ✅ Easier to test in isolation

### Cons:
- ❌ Adds an extra step before safe-settings
- ❌ Enriched data is committed to repo (more git history)
- ❌ Not run during safe-settings internal validation
- ❌ Requires GitHub Actions workflow maintenance

### Usage:

1. Set secrets in your repo:
   - `TECH_ASSET_SERVICE_URL`
   - `TECH_ASSET_SERVICE_TOKEN`

2. Create PR with:
```yaml
# .github/repos/my-repo.yml
custom_properties:
  - name: tech-asset-uuid
    value: "550e8400-e29b-41d4-a716-446655440000"
```

3. Workflow auto-enriches to:
```yaml
custom_properties:
  - name: tech-asset-uuid
    value: "550e8400-e29b-41d4-a716-446655440000"
  # Tech asset properties below are auto-generated from tech-asset-uuid
  # DO NOT EDIT MANUALLY - they will be overwritten
  - name: tech-asset-tag
    value: "PROD-API-001"
  - name: tech-asset-id
    value: "12345"
  - name: tech-asset-owner
    value: "backend-team"
```

---

## Comparison

| Feature | Plugin Approach | Actions Approach |
|---------|----------------|------------------|
| Safe-settings modifications | Required | None |
| Real-time validation | ✅ Yes | ❌ No |
| Dry-run support | ✅ Yes | ⚠️ Partial |
| Maintenance | Higher | Lower |
| Setup complexity | Higher | Lower |
| Git history | Clean | More commits |
| Independence | Coupled | Independent |

---

## Recommendation

**Start with Approach 2 (GitHub Actions)** if:
- You want to test the concept quickly
- You prefer not to fork safe-settings
- Your team is comfortable with GitHub Actions
- Enriched properties in git history is acceptable

**Use Approach 1 (Custom Plugin)** if:
- You already maintain a safe-settings fork
- You want deep integration with safe-settings validation
- Real-time validation is critical
- You prefer cleaner git history

---

## Files Created

### Approach 1 (Plugin):
```
lib/plugins/tech_asset_enrichment.js    (New plugin)
lib/settings.js                         (Modified to register plugin)
docs/tech-asset-enrichment.md           (Documentation)
examples/repo-with-tech-asset.yml       (Example config)
```

### Approach 2 (Actions):
```
.github/workflows/enrich-tech-assets.yml    (Workflow)
.github/scripts/enrich-tech-assets.js       (Script)
```

---

## External Service Requirements

Both approaches expect your tech asset service to provide:

**Endpoint:** `GET /assets/{uuid}`

**Response:**
```json
{
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "tag": "PROD-API-001",
  "id": "12345",
  "owner": "backend-team",
  "cost_center": "CC-9000",
  "classification": "confidential"
}
```

**Authentication:** Bearer token in `Authorization` header

---

## Next Steps

1. **Choose your approach** based on the comparison above
2. **Set up your external service** endpoint
3. **Configure environment variables**:
   ```bash
   TECH_ASSET_SERVICE_URL=https://your-api.com
   TECH_ASSET_SERVICE_TOKEN=your-token
   ```
4. **Test with a single repository** YAML file
5. **Roll out** to more repositories

---

## Testing

### Test External Service
```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://your-api.com/assets/550e8400-e29b-41d4-a716-446655440000
```

### Test Approach 1 (Plugin)
```bash
# Create a test PR with a repo YAML
# Check PR dry-run results
# Look for enrichment validation messages
```

### Test Approach 2 (Actions)
```bash
# Create a test PR with a repo YAML
# Watch GitHub Actions workflow run
# Check for auto-commit with enriched properties
```

---

## Questions?

Feel free to ask about:
- Customizing field mappings
- Adding caching to reduce API calls
- Handling rate limits
- Error handling strategies
- Migration strategies
- Performance optimization
