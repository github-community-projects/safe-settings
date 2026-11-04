# HubSyncHandler Architecture - Sequence Diagram

This document provides a detailed sequence diagram showing the flow of the Hub Sync Handler, which synchronizes safe-settings configurations between a centralized hub repository and organization-specific admin repositories.

## Main Flow

```mermaid
sequenceDiagram
    participant GH as GitHub Event
    participant Index as index.js
    participant HSH as hubSyncHandler
    participant SGU as syncHubGlobalsUpdate
    participant SOU as syncHubOrgUpdate
    participant HubRepo as Hub Repository
    participant OrgRepo as Org Admin Repo
    
    GH->>Index: pull_request.closed event
    Index->>HSH: hubSyncHandler(robot, context)
    
    HSH->>HSH: Validate event source
    Note over HSH: Check if from SAFE_SETTINGS_HUB_ORG/SAFE_SETTINGS_HUB_REPO
    
    alt Not from hub repo/org
        HSH->>Index: Return (ignore event)
    end
    
    HSH->>GH: Get PR changed files
    GH-->>HSH: List of changed files
    
    HSH->>HSH: Analyze changed files
    
    par Parallel Processing
        alt Files in globals/ folder
            HSH->>SGU: syncHubGlobalsUpdate(robot, context, files)
            SGU->>HubRepo: Load manifest.yml
            HubRepo-->>SGU: Manifest rules
            
            loop For each changed global file
                SGU->>SGU: Match file against manifest patterns
                
                loop For each matching rule
                    SGU->>SGU: Determine target orgs
                    Note over SGU: Use rule.orgs or all installations
                    
                    loop For each target org
                        SGU->>OrgRepo: Get installation
                        
                        alt Direct Push Mode
                            SGU->>OrgRepo: Push to main branch
                        else PR Mode
                            SGU->>OrgRepo: Create branch
                            SGU->>HubRepo: Get file content
                            SGU->>OrgRepo: Commit file
                            SGU->>OrgRepo: Create PR
                        end
                    end
                end
            end
        end
        
        alt Files in organizations/<org>/ folder
            HSH->>SOU: syncHubOrgUpdate(robot, context, orgName, destRepo, destFolder)
            
            SOU->>SOU: Extract org name from file path
            SOU->>OrgRepo: Get org installation
            
            alt Installation not found
                SOU->>HSH: Log warning and return
            end
            
            SOU->>HubRepo: Get changed files for org
            HubRepo-->>SOU: List of files
            
            alt Direct Push Mode
                SOU->>OrgRepo: Use main branch
            else PR Mode
                SOU->>OrgRepo: Create sync branch
                Note over SOU: safe-settings-sync/pr-{num}-{org}-{timestamp}
            end
            
            loop For each changed file
                SOU->>HubRepo: Get file content from PR head
                HubRepo-->>SOU: File content
                
                SOU->>OrgRepo: Check if file exists
                OrgRepo-->>SOU: Existing SHA (or 404)
                
                SOU->>OrgRepo: Create or update file
                Note over SOU: Commit with Safe Settings Bot identity
            end
            
            alt Direct Push Mode
                SOU->>HSH: Log direct push complete
            else PR Mode
                SOU->>OrgRepo: Create PR
                Note over SOU: Title: Sync safe-settings from hub PR #X
                OrgRepo-->>SOU: PR URL
            end
        end
    end
    
    HSH->>Index: Complete
```

## Reverse Flow: Import Settings from Orgs to Hub

```mermaid
sequenceDiagram
    participant API as API/Route Handler
    participant RSO as retrieveSettingsFromOrgs
    participant OrgRepo as Org Admin Repo
    participant HubRepo as Hub Repository
    
    API->>RSO: retrieveSettingsFromOrgs(robot, orgNames, options)
    
    RSO->>RSO: Get all installations
    RSO->>HubRepo: Get base branch ref (main)
    HubRepo-->>RSO: Base SHA
    
    loop For each org in orgNames
        RSO->>HubRepo: Check if org already exists
        Note over RSO: Path: CONFIG_PATH/SAFE_SETTINGS_HUB_PATH/organizations/<org>
        
        alt Org already imported
            RSO->>RSO: Skip org (already_imported)
        else Org not found in hub
            RSO->>RSO: Get org installation
            
            alt Installation not found
                RSO->>RSO: Record error and continue
            end
            
            RSO->>OrgRepo: Collect all files recursively
            Note over RSO: From CONFIG_PATH in ADMIN_REPO
            
            alt Admin repo not found
                RSO->>RSO: Record N/A status
            else Files collected
                OrgRepo-->>RSO: List of files with content
                
                RSO->>HubRepo: Create import branch
                Note over RSO: safe-settings-import/<org>/<timestamp>
                
                loop For each file
                    RSO->>HubRepo: Get existing file SHA (if exists)
                    RSO->>HubRepo: Create or update file
                    Note over RSO: Destination: organizations/<org>/<relative-path>
                end
                
                RSO->>HubRepo: Create PR
                Note over RSO: Title: Import safe-settings from <org>
                HubRepo-->>RSO: PR URL
                
                RSO->>RSO: Record import success
            end
        end
    end
    
    RSO-->>API: Return results array
    Note over RSO: [{org, status, reason|error}, ...]
```

## Key Decision Points

### Event Validation
```mermaid
flowchart TD
    A[PR Closed Event] --> B{From Hub Org?}
    B -->|No| C[Ignore Event]
    B -->|Yes| D{From Hub Repo?}
    D -->|No| C
    D -->|Yes| E[Process Event]
```

### File Routing Logic
```mermaid
flowchart TD
    A[Get Changed Files] --> B{Check File Paths}
    B --> C{Contains /globals/?}
    C -->|Yes| D[syncHubGlobalsUpdate]
    B --> E{Contains /organizations/?}
    E -->|Yes| F[Extract Org Names]
    F --> G[syncHubOrgUpdate for each org]
    C -->|No| H[No Action]
    E -->|No| H
```

### Sync Mode Decision
```mermaid
flowchart TD
    A[Ready to Sync] --> B{SAFE_SETTINGS_HUB_DIRECT_PUSH?}
    B -->|true| C[Push directly to main]
    B -->|false| D[Create sync branch]
    D --> E[Commit changes]
    E --> F[Create PR]
```

## Environment Variables

| Variable | Purpose | Used In |
|----------|---------|---------|
| `SAFE_SETTINGS_HUB_ORG` | Hub organization name | Event validation |
| `SAFE_SETTINGS_HUB_REPO` | Hub repository name | Event validation |
| `SAFE_SETTINGS_HUB_PATH` | Base path in hub (e.g., "safe-settings") | File path resolution |
| `ADMIN_REPO` | Target repo name in orgs | Destination repo |
| `CONFIG_PATH` | Config folder (e.g., ".github") | File path resolution |
| `SAFE_SETTINGS_HUB_DIRECT_PUSH` | Push mode ("true"/"false") | Branch vs direct push |

## Error Handling

All functions implement try-catch blocks with logging:
- **Installation errors**: Log warning and skip org
- **File read errors**: Log error and continue with next file
- **PR creation errors**: Log error and throw (stops sync for that org)
- **Repository not found**: Record as "N/A" status and continue

## Notes

- **Parallel Processing**: `syncHubGlobalsUpdate` and `syncHubOrgUpdate` can run in parallel if both globals and organizations folders have changes
- **Authentication**: Each org requires a separate authenticated octokit client via `robot.auth(installationId)`
- **File Logging**: All operations are logged to `hubSyncHandler.log` (configurable)
- **Idempotency**: Functions check for existing branches/PRs before creating new ones
