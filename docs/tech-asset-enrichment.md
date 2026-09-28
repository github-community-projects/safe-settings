# Example: Using Tech Asset Enrichment in safe-settings

## Overview

The `tech_asset_enrichment` plugin allows you to:
1. Validate custom properties against an external service
2. Automatically enrich repository configuration with additional metadata
3. Pre-validate configurations before they're applied

## Configuration

### 1. Environment Variables

Set these in your deployment:

```bash
# Required: Your external tech asset service
TECH_ASSET_SERVICE_URL=https://tech-asset-api.example.com
TECH_ASSET_SERVICE_TOKEN=your-api-token-here
```

### 2. Repository Configuration Example

**`.github/repos/my-api-service.yml`**

```yaml
# Basic repository settings
repository:
  name: my-api-service
  description: My awesome API service
  private: true
  has_issues: true
  has_wiki: false

# Enable tech asset enrichment
tech_asset_enrichment:
  service_url: https://tech-asset-api.example.com  # Optional: override env var
  service_token: ${TECH_ASSET_TOKEN}  # Optional: override env var

# Define the tech-asset-uuid custom property
# The enrichment plugin will:
# 1. Validate this UUID with your external service
# 2. Fetch additional metadata (tag, id, owner, etc.)
# 3. Automatically add additional custom properties
custom_properties:
  - name: tech-asset-uuid
    value: "550e8400-e29b-41d4-a716-446655440000"
  
  # These will be automatically added by the enrichment plugin:
  # - tech-asset-tag
  # - tech-asset-id  
  # - tech-asset-owner
  # You don't need to specify them manually!

# Other settings...
teams:
  - name: backend-team
    permission: push

labels:
  - name: bug
    color: d73a4a
  - name: enhancement
    color: a2eeef
```

### 3. External Service API Format

Your external tech asset service should respond to:

**Request:**
```
GET /assets/{uuid}
Authorization: Bearer {token}
```

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

## How It Works

### Flow Diagram

```
1. Safe-settings loads repo YAML config
   └─> Contains: tech_asset_enrichment + custom_properties with tech-asset-uuid

2. Tech Asset Enrichment Plugin runs FIRST
   ├─> Reads tech-asset-uuid value
   ├─> Validates UUID with external service
   ├─> Fetches additional metadata
   └─> Enriches custom_properties array with:
       ├─> tech-asset-tag
       ├─> tech-asset-id
       ├─> tech-asset-owner
       └─> Any other fields from service

3. Custom Properties Plugin runs SECOND
   └─> Applies ALL custom properties (original + enriched) to the repo

4. Other plugins run normally
```

### Validation Behavior

**✅ Valid UUID:**
- Plugin fetches metadata from service
- Enriches configuration with additional properties
- Continues to apply all settings
- Removes any previous `tech-asset-validation-error` topic

**❌ Invalid UUID:**
- Plugin logs error
- In DRY-RUN mode: Shows validation error in PR check
- In LIVE mode: Adds `tech-asset-validation-error` topic to repo
- Prevents configuration from being applied

## Example: Multi-environment Setup

**`.github/repos/frontend-app-prod.yml`**
```yaml
repository:
  name: frontend-app-prod
  
tech_asset_enrichment:
  enabled: true

custom_properties:
  - name: tech-asset-uuid
    value: "aaa-prod-111"
  - name: environment
    value: production
```

**`.github/repos/frontend-app-dev.yml`**
```yaml
repository:
  name: frontend-app-dev
  
tech_asset_enrichment:
  enabled: true

custom_properties:
  - name: tech-asset-uuid
    value: "bbb-dev-222"
  - name: environment
    value: development
```

## Suborg-Level Configuration

You can also set this at the suborg level:

**`.github/suborgs/backend-services.yml`**

```yaml
# This applies to all repos matching the suborg pattern
suborgteams:
  - backend-team
  - platform-team

# Tech asset enrichment for all repos in this suborg
tech_asset_enrichment:
  enabled: true

# Default custom properties for all repos
custom_properties:
  - name: tech-asset-uuid
    value: "${REPO_TECH_UUID}"  # Can use templating if supported
  - name: team
    value: backend
```

## Testing

### Dry-Run Mode (PR Checks)

When you create a PR to modify a repo's `tech-asset-uuid`:

1. Safe-settings runs in dry-run mode
2. Enrichment plugin validates the new UUID
3. PR check shows:
   - ✅ UUID validation passed
   - 📝 Additional properties that will be added
   - 🔄 Changes that will be applied

### Manual Testing

```bash
# Test your external service
curl -H "Authorization: Bearer $TECH_ASSET_SERVICE_TOKEN" \
  https://tech-asset-api.example.com/assets/550e8400-e29b-41d4-a716-446655440000

# Check GitHub repo custom properties
gh api repos/YOUR-ORG/my-api-service/properties/values
```

## Troubleshooting

### Error: "Invalid tech-asset-uuid"

**Cause:** The UUID doesn't exist in your external service

**Solution:**
1. Verify the UUID in your tech asset management system
2. Check service URL and token are correct
3. Look for `tech-asset-validation-error` topic on the repo

### Plugin Not Running

**Cause:** Plugin may not be enabled in config

**Solution:** Ensure `tech_asset_enrichment` section exists in your YAML:
```yaml
tech_asset_enrichment:
  enabled: true
```

### Properties Not Being Added

**Cause:** External service response format mismatch

**Solution:** Check plugin logs for the actual API response and verify it matches expected format

## Advanced: Custom Field Mapping

You can customize which fields from the external service get mapped to custom properties by modifying the plugin:

```javascript
// In lib/plugins/tech_asset_enrichment.js
const enrichedProperties = [
  { name: 'tech-asset-uuid', value: uuid },
  { name: 'tech-asset-tag', value: assetData.tag },
  { name: 'tech-asset-id', value: assetData.id },
  { name: 'tech-asset-owner', value: assetData.owner },
  // Add custom mappings:
  { name: 'cost-center', value: assetData.cost_center },
  { name: 'classification', value: assetData.classification }
]
```
