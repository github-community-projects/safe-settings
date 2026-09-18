# 🛡️ GitHub Safe-Settings

[![Create a release](https://github.com/github/safe-settings/actions/workflows/create-release.yml/badge.svg)](https://github.com/github/safe-settings/actions/workflows/create-release.yml)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

> **Policy-as-Code for GitHub Organizations**  
> Centrally manage and enforce repository settings, branch protections, teams, and more across your entire GitHub organization.

`Safe-settings` – an app to manage policy-as-code and apply repository settings across an organization.

1. In `safe-settings`, all the settings are stored centrally in an `admin` repo within the organization. Unlike the [GitHub Repository Settings App](https://github.com/repository-settings/app), the settings files cannot be in individual repositories.

   > It is possible specify a custom repo instead of the `admin` repo with `ADMIN_REPO`. See [Environment variables](#environment-variables) for more details.

1. The **settings** in the **default** branch are applied. If the settings are changed on a non-default branch and a PR is created to merge the changes, the app runs in a `dry-run` mode to evaluate and validate the changes. Checks pass or fail based on the `dry-run` results.

1. In `safe-settings` the settings can have 2 types of targets:
   1. `org` - These settings are applied to the organization. `Org`-targeted settings are defined in `.github/settings.yml`. Currently, only `rulesets` are supported as `org`-targeted settings.
   1. `repo` - These settings are applied to repositories.

1. For the `repo`-targeted settings, there can be 3 levels at which the settings are managed:
   1. `Org`-level settings are defined in `.github/settings.yml`

      > It is possible to override this behavior and specify a different filename for the `settings.yml` file with `SETTINGS_FILE_PATH`. Similarly, the `.github` directory can be overridden with `CONFIG_PATH`. See [Environment variables](#environment-variables) for more details.

   1. `Suborg` level settings. A `suborg` is an arbitrary collection of repos belonging to projects, business units, or teams. The `suborg` settings reside in a yaml file for each `suborg` in the `.github/suborgs` folder.

      > In `safe-settings`, `suborgs` could be groups of repos based on `repo names`, or `teams` which the repos have collaborators from, or `custom property values` set for the repos

   1. `Repo` level settings. They reside in a repo specific yaml in `.github/repos` folder

1. It is recommended to break the settings into `org`-level, `suborg`-level, and `repo`-level units. This will allow different teams to define and manage policies for their specific projects or business units. With `CODEOWNERS`, this will allow different people to be responsible for approving changes in different projects.

> [!NOTE]
> The `suborg` and `repo` level settings directory structure cannot be customized.

## 🚀 Quick Start

### 1. **Deploy Safe-Settings**

Choose your preferred deployment method:

- **🌟 AWS Lambda (**: Use the [SafeSettings-Template](https://github.com/bheemreddy181/SafeSettings-Template) for production-ready deployment with Docker containers, GitHub Actions CI/CD, and comprehensive testing
- **🐳 Docker**: Deploy using Docker containers locally or in your infrastructure
- **☁️ Cloud Platforms**: Deploy to Heroku, Glitch, or Kubernetes

👉 **[View all deployment options →](docs/deploy.md)**

### 2. **Create Admin Repository**

Create an `admin` repository in your organization to store all configuration files:

```bash
# Create admin repo in your organization
gh repo create your-org/admin --private
```

### 3. **Configure Settings Structure**

Set up your configuration files in the admin repository:

```
admin/
├── .github/
│   ├── settings.yml          # Organization-wide settings
│   ├── suborgs/              # Sub-organization settings
│   │   ├── frontend-team.yml
│   │   └── backend-team.yml
│   └── repos/                # Repository-specific settings
│       ├── api-service.yml
│       └── web-app.yml
```

### 4. **Install GitHub App**

Install the Safe-Settings GitHub App in your organization with the required permissions.

👉 **[Complete setup guide →](#how-to-use)**

## 📊 Visual Architecture

### Configuration Hierarchy

```mermaid
graph TD
    A[Organization Settings<br/>.github/settings.yml] --> B[Sub-Organization Settings<br/>.github/suborgs/*.yml]
    B --> C[Repository Settings<br/>.github/repos/*.yml]
    
    style A fill:#e1f5fe,stroke:#01579b,stroke-width:2px,color:#000
    style B fill:#f3e5f5,stroke:#4a148c,stroke-width:2px,color:#000
    style C fill:#e8f5e8,stroke:#1b5e20,stroke-width:2px,color:#000
```

**Precedence Order**: Repository > Sub-Organization > Organization

### Request Flow

```mermaid
sequenceDiagram
    participant GH as GitHub
    participant SS as Safe-Settings
    participant AR as Admin Repo
    participant TR as Target Repos
    
    Note over GH,TR: Webhook Event Processing
    
    GH->>+SS: Webhook Event<br/>(push, repo created, etc.)
    SS->>SS: Validate Event Source
    SS->>+AR: Fetch Configuration Files<br/>(.github/settings.yml, suborgs/, repos/)
    AR-->>-SS: Return Config Files
    
    SS->>SS: Merge Configurations<br/>(Org → Suborg → Repo)
    SS->>SS: Compare with Current<br/>GitHub Settings
    
    alt Configuration Changes Detected
        SS->>+TR: Apply Settings<br/>(Branch Protection, Teams, etc.)
        TR-->>-SS: Confirm Changes
        SS->>GH: Create Check Run<br/>(Success/Failure)
    else No Changes Needed
        SS->>GH: Create Check Run<br/>(No Changes)
    end
    
    SS-->>-GH: HTTP 200 Response
    
    Note over GH,TR: Pull Request Validation (Dry-Run Mode)
    
    GH->>+SS: PR Event<br/>(opened, synchronize)
    SS->>+AR: Fetch PR Changes<br/>(Modified Config Files)
    AR-->>-SS: Return Changed Configs
    
    SS->>SS: Validate Changes<br/>(Dry-Run Mode)
    SS->>SS: Run Custom Validators<br/>(if configured)
    
    alt Validation Passes
        SS->>GH: ✅ Check Success<br/>+ PR Comment (optional)
    else Validation Fails
        SS->>GH: ❌ Check Failure<br/>+ Error Details
    end
    
    SS-->>-GH: HTTP 200 Response
    
    Note over GH,TR: Scheduled Sync (Drift Prevention)
    
    SS->>SS: Cron Trigger<br/>(if configured)
    SS->>+AR: Fetch All Configurations
    AR-->>-SS: Return All Configs
    SS->>+TR: Sync All Repositories<br/>(Prevent Drift)
    TR-->>-SS: Confirm Sync
    SS->>GH: Create Check Run<br/>(Sync Results)
```

## How it works

`Safe-settings` is designed to run as a service listening for webhook events or as a scheduled job running on some regular cadence. It can also be triggered through GitHub Actions. (See the [How to use](#how-to-use) section for details on deploying and configuring.)


### Events
The App listens to the following webhook events:

- **push**: If the settings are created or modified, that is, if  push happens in the `default` branch of the `admin` repo and the file added or changed is `.github/settings.yml` or `.github/repos/*.yml`or `.github/suborgs/*.yml`, then the settings would be applied either globally to all the repos, or specific repos. For each repo, the settings that are actually applied depend on the default settings for the org, overlaid with settings for the suborg that the repo belongs to, overlaid with the settings for that specific repo.

- **repository.created**: If a repository is created in the org, the settings for the repo - the default settings for the org, overlaid with settings for the suborg that the repo belongs to, overlaid with the settings for that specific repo - is applied.

- **branch_protection_rule**: If a branch protection rule is modified or deleted, `safe-settings` will `sync` the settings to prevent any unauthorized changes.

- **repository.edited**: For e.g. If the default branch is renamed, or if topics change, `safe-settings` will `sync` the settings, to prevent any unauthorized changes.

- **repository.renamed**: If a repository is renamed, the default behavior is safe-settings will ignore this (for backward-compatibility). If `BLOCK_REPO_RENAME_BY_HUMAN` env variable is set to true, `safe-settings` will revert the repo to the previous name unless it is renamed using a `bot`. If it is renamed using a `bot`, it will try to copy the existing `<old-repo>.yml` to `<new-repo>.yml` so that the repo config yml stays consistent. If a <new-repo.yml> file already exists, it doesn't create a new one.

- **pull_request.opened**, **pull_request.reopened**, **check_suite.requested**: If the settings are changed, but it is not in the `default` branch, and there is an existing PR, the code will validate the settings changes by running safe-settings in `nop` mode and update the PR with the `dry-run` status.

- **repository_ruleset**: If the `ruleset` settings are modified in the UI manually, `safe-settings` will `sync` the settings to prevent any unauthorized changes.

- **member_change_events**: If a member is added or removed from a repository, `safe-settings` will `sync` the settings to prevent any unauthorized changes.

- **member**', __team.added_to_repository__, __team.removed_from_repository__, __team.edited__: `safe-settings` will `sync` the settings to prevent any unauthorized changes.

- __custom_property_values__: If new repository properties are set for a repository, `safe-settings` will run to so that if a sub-org config is defined by that property, it will be applied for the repo

### Use `safe-settings` to rename repos
If you rename a `<repo.yml>` that corresponds to a repo, safe-settings will rename the repo to the new name. This behavior will take effect whether the env variable `BLOCK_REPO_RENAME_BY_HUMAN` is set or not.

### Restricting `safe-settings` to specific repos

To restrict which repositories `safe-settings` can manage, create a `deployment-settings.yml` file. This file controls the app's scope through the `restrictedRepos` configuration:

```yml
# Using include/exclude
restrictedRepos:
  include:
    - api
    - core-*    # Matches `core-api`, `core-service`, etc.
  exclude:
    - admin
    - .github
    - safe-settings
    - test-*    # Matches `test-repo`, etc.

# Or using simple array syntax for includes
restrictedRepos: 
  - admin
  - .github
  # ...
```

> [!NOTE]
> Pattern matching uses glob expressions, e.g use * for wildcards.

When using `include` and `exclude`:

- If `include` is specified, will **only** run on repositories that match pattern(s)
- If `exclude` is specified, will run on all repositories **except** those matching pattern(s)
- If both are specified, will run only on included repositories that are'nt excluded

By default, if no configuration file is provided, `safe-settings` will excludes these repos: `admin`, `.github` and `safe-settings`.

See our [deployment-settings.yml sample](docs/sample-settings/sample-deployment-settings.yml).

### Custom rules

Admins setting up `safe-settings` can include custom rules that would be validated before applying a setting or overriding a broader scoped setting.

The code has to return `true` if validation is successful, or `false` if it isn't.

If the validation fails, the `error` attribute specified would be used to create the error message in the logs or in the `PR checks`.

The first use case is where a custom rule has to be applied for a setting on its own. For e.g. No collaborator should be given `admin` permissions.

For this type of validation, admins can provide custom code as `configvalidators` which validates the setting by itself.

For e.g. for the case above, it would look like:
```yaml
configvalidators:
  - plugin: collaborators
    error: |
      `Admin role cannot be assigned to collaborators`
    script: |
      console.log(`baseConfig ${JSON.stringify(baseconfig)}`)
      return baseconfig.permission != 'admin'
```

For convenience this script has access to a variable, `baseconfig`, that contains the setting that is be applied.

The second use case is where custom rule has to be applied when a setting in the org or suborg level is being overridden. Such as, when default branch protection is being overridden.

For this type of validation, admins can provide custom code as `overridevalidators`. The script can access two variables, `baseconfig` and `overrideconfig` which represent the base setting and the setting that is overriding it.

A sample would look like:

```yaml
overridevalidators:
  - plugin: branches
    error: |
      `Branch protection required_approving_review_count cannot be overidden to a lower value`
    script: |
      console.log(`baseConfig ${JSON.stringify(baseconfig)}`)
      console.log(`overrideConfig ${JSON.stringify(overrideconfig)}`)
      if (baseconfig.protection.required_pull_request_reviews.required_approving_review_count && overrideconfig.protection.required_pull_request_reviews.required_approving_review_count ) {
        return overrideconfig.protection.required_pull_request_reviews.required_approving_review_count >= baseconfig.protection.required_pull_request_reviews.required_approving_review_count
      }
      return true
```

A sample of `deployment-settings` file is found [here](docs/sample-settings/sample-deployment-settings.yml).

### Custom Status Checks
For branch protection rules and rulesets, you can allow for status checks to be defined outside of safe-settings together with your usual safe settings.

This can be defined at the org, sub-org, and repo level.

To configure this for branch protection rules, specify `{{EXTERNALLY_DEFINED}}` under the `contexts` keyword:
```yaml
branches:
  - name: main
    protection:
      ...
      required_status_checks:
        contexts:
          - "{{EXTERNALLY_DEFINED}}"
```

For rulesets, specify `{{EXTERNALLY_DEFINED}}` under the `required_status_checks` keyword:
```yaml
rulesets:
  - name: Status Checks
    ...
    rules:
      - type: required_status_checks
        parameters:
          required_status_checks:
            - context: "{{EXTERNALLY_DEFINED}}"
```

Notes:
  - For the same branch that is covered by multi-level branch protection rules, contexts defined at the org level are merged into the sub-org and repo level contexts, while contexts defined at the sub-org level are merged into the repo level contexts.
  - Rules from the sub-org level are merged into the repo level when their ruleset share the same name. Becareful not to define the same rule type in both levels as it will be rejected by GitHub.
  - When `{{EXTERNALLY_DEFINED}}` is defined for a new branch protection rule or ruleset configuration, they will be deployed with no status checks.
  - When an existing branch protection rule or ruleset configuration is amended with `{{EXTERNALLY_DEFINED}}`, the status checks in the existing rules in GitHub will remain as is.

> ⚠️ **Warning:**
When `{{EXTERNALLY_DEFINED}}` is removed from an existing branch protection rule or ruleset configuration, the status checks in the existing rules in GitHub will revert to the checks that are defined in safe-settings. From this point onwards, all status checks configured through the GitHub UI will be reverted back to the safe-settings configuration.

#### Status checks inheritance across scopes
Refer to [Status checks](docs/status-checks.md).

### Performance
When there are 1000s of repos to be managed -- and there is a global settings change -- safe-settings will have to work efficiently and only make the necessary API calls.

The app also has to complete the work within an hour: the lifetime of the GitHub app token.

To address these constraints the following design decisions have been implemented:
1. `Probot` automatically handles `rate` and `abuse` limits.
2. Instead of loading all the repo contents from `.github/repos/*`, it will selectively load the specific repo file based on which `repo` settings has changed, or a subset of the repo files associated with `suborg` settings that has changed. The only time all the repo files will be loaded is if there is a `global` settings file change.
3. The PR check will only provide a summary of errors and changes. (Providing the details of changes for 1000s of repos will error out.)
4. To ensure it handles updates to GitHub intelligently, it will compare the changes with the settings in GitHub, and  will call the API only if there are `real` changes.

#### Comparing changes with GitHub
To determine if there are `real` changes, the code will generate a detailed list of `additions`, `modifications`, and `deletions` compared to the settings in GitHub:

For e.g:

If the settings is:
```json
{
  "branches": [
    {
      "name": "master",
      "protection": {
        "required_pull_request_reviews": {
          "required_approving_review_count": 2,
          "dismiss_stale_reviews": false,
          "require_code_owner_reviews": true,
          "dismissal_restrictions": {}
        },
        "required_status_checks": {
          "strict": true,
          "contexts": []
        },
        "enforce_admins": false
      }
    }
  ]
}
```

and the settings in GitHub is:
```json
{
  "branches": [
    {
      "name": "master",
      "protection": {
        "url": "https://api.github.com/repos/decyjphr-org/test/branches/develop/protection",
        "required_status_checks": {
          "url": "https://api.github.com/repos/decyjphr-org/test/branches/develop/protection/required_status_checks",
          "strict": true,
          "contexts": [],
          "contexts_url": "https://api.github.com/repos/decyjphr-org/test/branches/develop/protection/required_status_checks/contexts",
          "checks": []
        },
        "restrictions": {
          "url": "https://api.github.com/repos/decyjphr-org/test/branches/develop/protection/restrictions",
          "users_url": "https://api.github.com/repos/decyjphr-org/test/branches/develop/protection/restrictions/users",
          "teams_url": "https://api.github.com/repos/decyjphr-org/test/branches/develop/protection/restrictions/teams",
          "apps_url": "https://api.github.com/repos/decyjphr-org/test/branches/develop/protection/restrictions/apps",
          "users": [],
          "teams": [],
          "apps": []
        },
        "required_pull_request_reviews": {
          "url": "https://api.github.com/repos/decyjphr-org/test/branches/develop/protection/required_pull_request_reviews",
          "dismiss_stale_reviews": true,
          "require_code_owner_reviews": true,
          "required_approving_review_count": 2,
          "dismissal_restrictions": {
            "url": "https://api.github.com/repos/decyjphr-org/test/branches/develop/protection/dismissal_restrictions",
            "users_url": "https://api.github.com/repos/decyjphr-org/test/branches/develop/protection/dismissal_restrictions/users",
            "teams_url": "https://api.github.com/repos/decyjphr-org/test/branches/develop/protection/dismissal_restrictions/teams",
            "users": [],
            "teams": []
          }
        },
        "required_signatures": false,
        "enforce_admins": false,
        "required_linear_history": false,
        "allow_force_pushes": {
          "enabled": false
        },
        "allow_deletions": false,
        "required_conversation_resolution": false
      }
    }
  ]
}
```

the results of comparison would be:
```json
{
      "additions": {},
      "modifications": {
        "branches": [
          {
            "protection": {
              "required_pull_request_reviews": {
                "dismiss_stale_reviews": false
              }
            },
            "name": "master"
          }
        ]
      },
      "deletions": {},
      "hasChanges": true
    }
```
### Schedule
The App can be configured to apply the settings on a schedule. This could be a way to address configuration drift since webhooks are not always guaranteed to be delivered.

To periodically converge the settings to the configuration, set the `CRON` environment variable. See [Environment variables](#environment-variables) for more details.

### Pull Request Workflow
`Safe-settings` explicitly looks in the `admin` repo in the organization for the settings files. The `admin` repo could be a restricted repository with `branch protections` and `CODEOWNERS`

In that set up, when changes happen to the settings files and there is a PR for merging the changes back to the `default` branch in the `admin` repo, `safe-settings` will run `checks`  – which will run in **nop** mode and produce a report of the changes that would happen, including the API calls and the payload.

For e.g. If we have `override` validators that will fail if `org`-level branch protections are overridden at the repo or suborg level with a lesser number of required approvers, here is an screenshot of what users will see in the PR.
<p>
<img width="467" alt="image" src="https://github.com/github/safe-settings/assets/57544838/cc5d59fb-3d7c-477b-99e9-94bcafd07c0b">
</p>

> [!NOTE]
> If you don't want the PR message to have these details, they can be turned off with `CREATE_PR_COMMENT`. See [Environment variables](#environment-variables) for more details.

Here is a screenshot of what the users will see in the `checkrun` page:
<p>
<img width="462" alt="image" src="https://github.com/github/safe-settings/assets/57544838/c875224f-894b-45da-a9cc-4bfc75c47670">
</p>

### Error handling
The app creates a `Check` at the end of its processing to indicate if there were any errors. The `Check` is called `safe-settings` and corresponds to the latest commit on the `default` branch of the `admin` repo.

Here is an example of a `checkrun` result:
<p>
<img width="944" alt="image" src="https://github.com/github/safe-settings/assets/57544838/7ccedcea-628e-4055-a5a5-b8e45123777e">
</p>

And the `checkrun` page will look like this:
<p>
<img width="860" alt="image" src="https://github.com/github/safe-settings/assets/57544838/893ff4e6-904c-4a07-924a-7c23dc068983">
</p>

### The Settings Files

The settings files can be used to set the policies at the `org`, `suborg` or `repo` level.

The following can be configured:

- `Repository settings` - home page, url, visibility, has_issues, has_projects, wikis, etc.
- `Default branch` - naming and renaming
- `Topics`
- `Custom properties`
- `Teams and permissions`
- `Collaborators and permissions`
- `Issue labels`
- `Milestones`
- `Branch protections` - if the name of the branch is `default` in the settings, it is applied to the `default` branch of the repo.
- `Autolinks`
- `Repository name validation` using regex pattern
- `Rulesets`
- `Environments` - wait timer, required reviewers, prevent self review, protected branches deployment branch policy, custom deployment branch policy, variables, deployment protection rules

See [`docs/sample-settings/settings.yml`](docs/sample-settings/settings.yml) for a sample settings file.

> [!note]
> When using `collaborators`, `teams` or `labels`, you can control which repositories they apply to using `include` and `exclude`:
>
> - If `include` is specified, settings will **only** apply to repositories that match those patterns
> - If `exclude` is specified, settings will apply to all repositories **except** those matching the patterns  
> - If both are specified, `exclude` takes precedence over `include` but `include` patterns will still be respected
>
> Pattern matching uses glob expressions, e.g use * for wildcards. For example:
>
> ```yml
> teams:
>   - name: Myteam-admins
>     permission: admin
>   - name: Myteam-developers
>     permission: push
>   - name: Other-team
>     permission: push
>     include:
>       - '*-config'
>  ```

### Additional values

In addition to the values in the file above, the settings file can have some additional values:

1. `force_create`: This is set in the repo-level settings to force create the repo if the repo does not exist.
2. `template`: This is set in the repo-level settings, and is used with the `force_create` flag to use a specific repo template when creating the repo
3. `suborgrepos`: This is set in the suborg-level settings to define an array of repos. This field can also take a `glob` pattern to allow wild-card expression to specify repos in a suborg. For e.g. `test*` would include `test`, `test1`, `testing`, etc.
4. The `suborgteams` section contains a list of teams, and all the repos belonging to the teams would be part of the `suborg`


### Environment variables

You can pass environment variables; the easiest way to do it is via a `.env` file.

1. `CRON` you can pass a cron input to run `safe-settings` at a regular schedule. This is based on [node-cron](https://www.npmjs.com/package/node-cron). For eg.
  ```
  # ┌────────────── second (optional)
  # │ ┌──────────── minute
  # │ │ ┌────────── hour
  # │ │ │ ┌──────── day of month
  # │ │ │ │ ┌────── month
  # │ │ │ │ │ ┌──── day of week
  # │ │ │ │ │ │
  # │ │ │ │ │ │
  # * * * * * *
  CRON=* * * * * # Run every minute
  ```
1. Logging level can be set using `LOG_LEVEL`. For e.g.
  ```
  LOG_LEVEL=trace
  ```
1. Configure the source repository using `ADMIN_REPO` (default is `admin`). For e.g.
  ```
  ADMIN_REPO=safe-settings-config
  ```
1. Configure the config path using `CONFIG_PATH` (default is `.github`). For e.g.
  ```
  CONFIG_PATH=.github
  ```
1. Configure the settings file path using `SETTINGS_FILE_PATH` (default is `settings.yml`). For e.g.
  ```
  SETTINGS_FILE_PATH=settings.yml
  ```
1. Configure the deployment settings file path using `DEPLOYMENT_CONFIG_FILE` (default is `deployment-settings.yml`). For e.g.
  ```
  DEPLOYMENT_CONFIG_FILE=deployment-settings.yml
  ```
1. Enable the pull request comment using `ENABLE_PR_COMMENT` (default is `true`). For e.g.
  ```
  ENABLE_PR_COMMENT=true
  ```
1. Add a repos-considered/affected/errors/plugins-affected summary line, a link to the check run, and a review-verification checkbox to the pull request comment using `PR_COMMENT_SUMMARY_ENABLED` (default is `false`). For e.g.
  ```
  PR_COMMENT_SUMMARY_ENABLED=true
  ```
1. Block repository renaming manually using `BLOCK_REPO_RENAME_BY_HUMAN` (default is `false`). For e.g.
  ```
  BLOCK_REPO_RENAME_BY_HUMAN=true
  ```


### Runtime Settings

1. Besides the above settings files, the application can be bootstrapped with `runtime` settings.
2. The `runtime` settings are configured in `deployment-settings.yml` that is in the directory from where the GitHub app is running.
3. Currently the only setting that is possible are `restrictedRepos: [... ]` which allows you to configure a list of repos within your `org` that are excluded from the settings. If the `deployment-settings.yml` is not present, the following repos are added by default to the `restricted`repos list: `'admin', '.github', 'safe-settings'`


### Notes

1. Label color can also start with `#`, e.g. `color: '#F341B2'`. Make sure to wrap it with quotes!
1. Each top-level element under branch protection must be filled (eg: `required_pull_request_reviews`, `required_status_checks`, `enforce_admins` and `restrictions`). If you don't want to use one of them you must set it to `null` (see comments in the example above). Otherwise, none of the settings will be applied.
2. The precedence order is repository > suborg > org (.github/repos/*.yml > .github/suborgs/*.yml > .github/settings.yml


## How to use

1. Create an `admin` repo (or an alternative of your choosing) within your organization. Remember to set `ADMIN_REPO` if you choose something other than `admin`. See [Environment variables](#environment-variables) for more details.

2. Add the settings for the `org`, `suborgs`, and `repos`. Sample files can be found [here](docs/sample-settings).

3. __[Deploy and install the app](docs/deploy.md)__.  Alternatively, the __[GitHub Actions Guide](docs/github-action.md)__ describes how to run `safe-settings` with GitHub Actions.




## License

`safe-settings` is licensed under the [ISC license](https://github.com/github/safe-settings/blob/master/LICENSE)

`safe-settings` uses 3rd party libraries, each with their own license. These are found [here](https://github.com/github/safe-settings/blob/master/NOTICE.md).


[dependabot-link]: https://dependabot.com/

[dependabot-badge]: https://badgen.net/dependabot/probot/settings/?icon=dependabot

[github-actions-ci-link]: https://github.com/probot/settings/actions?query=workflow%3A%22Node.js+CI%22+branch%3Amaster

[github-actions-ci-badge]: https://github.com/probot/settings/workflows/Node.js%20CI/badge.svg
