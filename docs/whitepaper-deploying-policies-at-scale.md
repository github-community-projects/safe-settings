# Deploying Policies at Scale Across Organizations Using GitHub Safe-Settings

## A White Paper on Policy-as-Code for GitHub Enterprise Governance

---

**Version:** 1.0  
**Date:** May 2026  
**Author:** GitHub Safe-Settings Team

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [The Challenge: Governing Repositories at Scale](#the-challenge-governing-repositories-at-scale)
3. [Introducing Safe-Settings: Policy-as-Code for GitHub](#introducing-safe-settings-policy-as-code-for-github)
4. [Architecture Overview](#architecture-overview)
5. [The Configuration Hierarchy](#the-configuration-hierarchy)
6. [Designing Your Policy Framework](#designing-your-policy-framework)
7. [Deployment Models](#deployment-models)
8. [Scaling Strategies](#scaling-strategies)
9. [Governance Workflows](#governance-workflows)
10. [Advanced Policy Controls](#advanced-policy-controls)
11. [Drift Detection and Remediation](#drift-detection-and-remediation)
12. [Multi-Organization Deployments](#multi-organization-deployments)
13. [Security Considerations](#security-considerations)
14. [Case Study: Enterprise Rollout](#case-study-enterprise-rollout)
15. [Best Practices](#best-practices)
16. [Conclusion](#conclusion)

---

## Executive Summary

As organizations scale their software delivery practices on GitHub, managing repository configurations consistently across hundreds or thousands of repositories becomes a critical governance challenge. Manual configuration is error-prone, difficult to audit, and impossible to enforce at scale.

**GitHub Safe-Settings** provides a policy-as-code solution that enables organizations to centrally define, enforce, and audit repository settings across an entire GitHub organization. By storing configuration as YAML in a centralized admin repository, Safe-Settings brings the principles of Infrastructure-as-Code to GitHub governance — enabling version control, peer review, automated validation, and continuous enforcement of organizational policies.

This white paper provides a comprehensive guide to deploying Safe-Settings at enterprise scale, covering architecture decisions, policy design patterns, scaling strategies, and operational best practices.

---

## The Challenge: Governing Repositories at Scale

### The Problem

Enterprise organizations on GitHub commonly face these governance challenges:

- **Configuration sprawl**: Thousands of repositories with inconsistent settings — varying branch protections, team permissions, security configurations, and compliance controls.
- **Manual drift**: Repository administrators making ad-hoc changes that deviate from organizational standards, often without audit trails.
- **Onboarding delays**: New repositories require manual setup of branch protections, team access, labels, and compliance configurations.
- **Audit burden**: Demonstrating compliance with internal security policies or regulatory requirements (SOC 2, FedRAMP, HIPAA) demands evidence that every repository meets baseline standards.
- **Decentralized ownership**: Different teams need autonomy to manage their project-specific settings while still adhering to organization-wide baselines.

### Why Existing Approaches Fall Short

| Approach | Limitation |
|----------|-----------|
| **Manual configuration** | Does not scale; no audit trail; prone to drift |
| **GitHub repository templates** | Only applies at creation time; no ongoing enforcement |
| **Custom scripts/APIs** | High maintenance; fragile; no built-in review workflow |
| **Per-repo settings files** | Settings files live in individual repos, meaning any contributor can bypass policies |

Safe-Settings addresses all of these limitations by centralizing policy definitions in a protected admin repository, enforcing them continuously, and providing a pull request-based review workflow for all changes.

---

## Introducing Safe-Settings: Policy-as-Code for GitHub

Safe-Settings is a GitHub App built on the [Probot](https://probot.github.io/) framework that implements policy-as-code for GitHub organizations. It operates on three foundational principles:

### 1. Centralized Configuration

All settings are stored in a single `admin` repository (configurable via the `ADMIN_REPO` environment variable). Unlike per-repo settings files, this prevents repository maintainers from overriding organizational policies.

### 2. Hierarchical Policy Model

Settings are defined at three levels with a clear precedence order:

```
Organization (baseline) → Sub-Organization (team/project overrides) → Repository (specific exceptions)
```

Higher-specificity levels override lower ones, enabling a flexible yet governed configuration model.

### 3. Continuous Enforcement

Safe-Settings responds to webhook events in real-time and can run on a configurable schedule (via cron) to detect and remediate configuration drift — ensuring that manual changes are automatically reverted to the declared policy state.

### What Can Be Managed

Safe-Settings supports a comprehensive set of GitHub configurations:

| Category | Capabilities |
|----------|-------------|
| **Repository Settings** | Visibility, description, homepage, merge strategies, wiki, issues, projects, default branch, auto-init, security settings |
| **Branch Protections** | Required reviews, status checks, admin enforcement, push restrictions, dismiss stale reviews, code owner reviews |
| **Rulesets** | Organization and repository-level rulesets with branch/tag targeting, bypass actors, pattern rules, required workflows |
| **Teams & Collaborators** | Team permissions, collaborator access with include/exclude patterns |
| **Labels & Milestones** | Standardized issue labels and milestone definitions |
| **Custom Properties** | Organization-defined custom property values for repositories |
| **Environments** | Deployment environments with protection rules, wait timers, reviewers, and environment variables |
| **Autolinks** | External reference linking (e.g., Jira ticket prefixes) |
| **Repository Naming** | Regex-based validation of repository names |
| **Custom Repository Roles** | Organization-level custom roles |
| **Variables** | Repository and environment variables |

---

## Architecture Overview

### System Components

```
┌─────────────────────────────────────────────────────────────────┐
│                        GitHub Platform                          │
│                                                                 │
│  ┌──────────┐   ┌──────────────┐   ┌──────────────────────┐    │
│  │  Webhooks │   │  Admin Repo  │   │  Target Repositories │    │
│  │  (Events) │   │  (Policies)  │   │  (1000s of repos)    │    │
│  └─────┬─────┘   └──────┬───────┘   └──────────┬───────────┘    │
│        │                │                      │                │
└────────┼────────────────┼──────────────────────┼────────────────┘
         │                │                      │
         ▼                ▼                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Safe-Settings App                           │
│                                                                 │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────────┐     │
│  │ Event Handler │  │ Config Merger │  │  Plugin Engine   │     │
│  │ (Webhooks)    │  │ (Hierarchy)   │  │  (API Calls)     │     │
│  └──────────────┘  └───────────────┘  └──────────────────┘     │
│                                                                 │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────────┐     │
│  │ Drift Detect  │  │  Validators  │  │  Diff Engine     │     │
│  │ (Cron Sync)   │  │  (Rules)     │  │  (Smart Compare) │     │
│  └──────────────┘  └───────────────┘  └──────────────────┘     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Event Processing Flow

Safe-Settings listens to the following webhook events and responds accordingly:

| Event | Action |
|-------|--------|
| `push` to admin repo (default branch) | Apply changed settings to affected repositories |
| `repository.created` | Apply full policy stack (org → suborg → repo) to the new repository |
| `repository.edited` | Sync settings to prevent unauthorized changes |
| `repository.renamed` | Optionally block human-initiated renames; sync config files for bot-initiated renames |
| `branch_protection_rule` | Revert unauthorized branch protection changes |
| `repository_ruleset` | Revert unauthorized ruleset modifications |
| `member` / `team` changes | Revert unauthorized collaborator or team permission changes |
| `custom_property_values` | Re-evaluate suborg membership and apply matching policies |
| `pull_request` (to admin repo) | Run in dry-run/NOP mode and report validation results as check runs |

### Smart Diff Engine

Safe-Settings does not blindly apply configuration on every event. It performs an intelligent comparison between the declared policy and the current GitHub state, generating a precise diff of `additions`, `modifications`, and `deletions`. API calls are made only when real changes exist, which is critical for performance at scale.

---

## The Configuration Hierarchy

### Directory Structure

All policy files reside in the admin repository under the `.github` directory:

```
admin-repo/
├── .github/
│   ├── settings.yml              # Organization-wide baseline policies
│   ├── suborgs/                  # Sub-organization policies
│   │   ├── platform-team.yml     # Policies for platform team repos
│   │   ├── frontend-team.yml     # Policies for frontend team repos
│   │   ├── compliance-critical.yml # Policies for compliance-critical repos
│   │   └── open-source.yml       # Policies for open-source repos
│   └── repos/                    # Repository-specific overrides
│       ├── api-gateway.yml       # Specific settings for api-gateway
│       ├── auth-service.yml      # Specific settings for auth-service
│       └── docs-site.yml         # Specific settings for docs-site
├── CODEOWNERS                    # Governs who can approve policy changes
└── deployment-settings.yml       # Runtime configuration for the app
```

### Precedence Order

```
Repository-specific > Sub-Organization > Organization
```

When Safe-Settings computes the effective configuration for a given repository, it:

1. Starts with the **organization-level** settings from `settings.yml`
2. Overlays any matching **sub-organization** settings
3. Overlays any **repository-specific** settings

This layered approach means that organization-wide baselines are always applied, but teams can customize settings within the bounds defined by validators.

### Sub-Organization Membership

Sub-organizations ("suborgs") are a powerful abstraction for grouping repositories. A repository can belong to a suborg based on three criteria:

| Criterion | Configuration Key | Example |
|-----------|------------------|---------|
| **Repository name pattern** | `suborgrepos` | `suborgrepos: ["api-*", "service-*"]` |
| **Team membership** | `suborgteams` | `suborgteams: ["platform-core"]` |
| **Custom property values** | `suborgproperties` | `suborgproperties: [{"compliance": "sox"}]` |

This flexibility enables policies to be applied based on organizational structure, project taxonomy, or compliance classification — all without hard-coding repository lists.

---

## Designing Your Policy Framework

### Step 1: Define Your Organization Baseline

> **⚠️ Scaling Best Practice: Keep `settings.yml` Minimal**
>
> Any change to the org-level `settings.yml` triggers Safe-Settings to process **every managed repository** in the organization. For orgs with thousands of repos, this can cascade into thousands of API calls and risk breaching GitHub's API rate limits within the 1-hour token lifetime.
>
> **Recommended approach:** Limit `settings.yml` to resources that are applied at the **org level** — specifically **org-level rulesets** and **custom repository roles**. These are managed via org-scoped API endpoints and do **not** require per-repo API calls.
>
> Move repo-scoped settings (repository configuration, teams, collaborators, labels, branch protections, etc.) to **suborg-level** files. This way, changes only affect the subset of repos matched by each suborg, keeping API call volume manageable and predictable.

Define your organization-wide baseline using org-level rulesets and custom roles:

```yaml
# .github/settings.yml — Organization baseline
# Keep this file minimal: only org-level rulesets and custom roles.
# Repo-scoped settings (teams, labels, repository config) belong in suborgs.

rulesets:
  - name: Branch Protection
    target: branch
    enforcement: active
    bypass_actors:
      - actor_id: 1
        actor_type: OrganizationAdmin
        bypass_mode: always
    conditions:
      ref_name:
        include: ["~DEFAULT_BRANCH"]
        exclude: []
      repository_name:
        include: ["~ALL"]
        exclude: []
    rules:
      - type: pull_request
        parameters:
          dismiss_stale_reviews_on_push: true
          require_code_owner_review: true
          require_last_push_approval: true
          required_approving_review_count: 1
          required_review_thread_resolution: true
      - type: required_status_checks
        parameters:
          strict_required_status_checks_policy: true
          required_status_checks: []

  - name: Branch Integrity
    target: branch
    enforcement: active
    bypass_actors:
      - actor_id: 1
        actor_type: OrganizationAdmin
        bypass_mode: always
    conditions:
      ref_name:
        include: ["~DEFAULT_BRANCH"]
        exclude: []
      repository_name:
        include: ["~ALL"]
        exclude: []
    rules:
      - type: deletion
      - type: non_fast_forward
      - type: required_linear_history
      - type: required_signatures
```

Then define repo-scoped baseline settings at the **suborg level** to avoid cascading org-wide API calls. Use a broad suborg definition (e.g., `~ALL` repos or a wildcard pattern) to achieve org-wide coverage without the scaling risks:

```yaml
# .github/suborgs/baseline.yml — Default repo-scoped settings for all repos
# Changes here only trigger API calls for matched repos, not the entire org.

suborgrepos:
  - "*"

repository:
  private: true
  allow_auto_merge: false
  delete_branch_on_merge: true
  allow_update_branch: true
  security:
    enableVulnerabilityAlerts: true
    enableAutomatedSecurityFixes: true

teams:
  - name: security-team
    permission: admin
  - name: all-engineers
    permission: push

labels:
  - name: bug
    color: "d73a4a"
    description: "Something isn't working"
  - name: security
    color: "e11d48"
    description: "Security-related issue"
  - name: compliance
    color: "7c3aed"
    description: "Compliance-related"

validator:
  pattern: "[a-z0-9]+(-[a-z0-9]+)*"
```

### Step 2: Define Sub-Organization Policies

Create suborg files for teams or projects that need additional or different policies:

```yaml
# .github/suborgs/compliance-critical.yml

# Repos with the "compliance" custom property set to "sox"
suborgproperties:
  - compliance: sox

# Stricter branch protections for SOX-compliant repositories
branches:
  - name: default
    protection:
      required_pull_request_reviews:
        required_approving_review_count: 2
        dismiss_stale_reviews: true
        require_code_owner_reviews: true
        require_last_push_approval: true
      enforce_admins: true

# Additional team access for compliance repos
teams:
  - name: compliance-auditors
    permission: pull
```

```yaml
# .github/suborgs/open-source.yml

suborgrepos:
  - "oss-*"

repository:
  private: false
  visibility: public
  has_wiki: true

# Public repos need different branch protections
branches:
  - name: default
    protection:
      required_pull_request_reviews:
        required_approving_review_count: 2
        require_code_owner_reviews: true
```

### Step 3: Define Repository-Specific Overrides

For repositories that need unique configurations:

```yaml
# .github/repos/api-gateway.yml

repository:
  description: "Central API gateway for all microservices"
  homepage: "https://api-docs.example.com"
  topics:
    - api
    - gateway
    - critical-infrastructure

branches:
  - name: default
    protection:
      required_status_checks:
        strict: true
        contexts:
          - "ci/build"
          - "ci/integration-tests"
          - "security/codeql"

environments:
  - name: production
    wait_timer: 30
    prevent_self_review: true
    reviewers:
      - type: Team
        id: 12345  # platform-leads team
    deployment_branch_policy:
      protected_branches: true
      custom_branch_policies: false
```

---

## Deployment Models

Safe-Settings supports multiple deployment architectures to fit your infrastructure requirements.

### Docker (Recommended for Most Organizations)

Best for organizations with existing container infrastructure.

```bash
# Build and run
docker build -t safe-settings .
docker run -d -p 3000:3000 --env-file .env safe-settings

# Or with docker-compose
docker-compose --env-file .env up -d
```

**Advantages:** Simple, portable, works with any container orchestration platform.

### Kubernetes with Helm

Best for organizations running Kubernetes clusters.

```bash
# Install using the official Helm chart
helm install safe-settings \
  oci://ghcr.io/github/helm-charts/safe-settings \
  --values myvalues.yaml
```

**Advantages:** Native Kubernetes integration, auto-scaling, rolling updates, health checks, secrets management via Kubernetes Secrets or external secret stores.

### AWS Lambda (Serverless)

Best for organizations wanting minimal infrastructure overhead.

Use the [SafeSettings-Template](https://github.com/bheemreddy181/SafeSettings-Template) for a production-ready deployment featuring:

- Docker-based Lambda functions
- Dual Lambda architecture (webhook handler + scheduled sync)
- GitHub Actions CI/CD pipeline
- Auto-scaling with pay-per-execution pricing

### GitHub Actions

Best for organizations that want to avoid deploying infrastructure entirely.

Safe-Settings can be run as a GitHub Action, triggered by workflow dispatch or on a schedule. See the [GitHub Actions Guide](github-action.md) for configuration details.

### Deployment Comparison

| Model | Scalability | Operational Overhead | Real-Time Events | Scheduled Sync | Cost Model |
|-------|-------------|---------------------|-------------------|----------------|------------|
| **Docker** | Medium | Medium | ✅ Webhooks | ✅ CRON | Fixed |
| **Kubernetes** | High | Medium-High | ✅ Webhooks | ✅ CRON | Fixed |
| **AWS Lambda** | Very High | Low | ✅ Webhooks | ✅ EventBridge | Pay-per-use |
| **GitHub Actions** | Medium | Very Low | ❌ Polling only | ✅ Cron triggers | Actions minutes |

---

## Scaling Strategies

### Performance Considerations

When managing thousands of repositories, Safe-Settings employs several strategies to operate within constraints:

1. **Org-level settings are org-scoped**: Rulesets and custom repository roles defined in `settings.yml` are applied via org-level API endpoints — they do **not** generate per-repo API calls. This is why `settings.yml` should be reserved for these resources only.

2. **Selective configuration loading**: Only repo-specific YAML files relevant to the changed settings are loaded — not the entire `.github/repos/` directory. Full loading occurs only for global settings changes.

3. **Smart diff comparisons**: Before making any API call, Safe-Settings compares the desired state with the current GitHub state. API calls are only made when real changes are detected.

4. **Rate limit handling**: Built on Probot, the app automatically handles GitHub API rate limits and abuse limits with exponential backoff.

5. **Token lifetime awareness**: GitHub App installation tokens expire after 1 hour. Safe-Settings is designed to complete all work within this window.

### Configuration for Large Organizations

For organizations with 1,000+ repositories, consider these configurations:

```env
# Run scheduled sync during off-peak hours
CRON=0 2 * * *

# Set appropriate log level for production
LOG_LEVEL=info

# Enable PR comments for audit trail
ENABLE_PR_COMMENT=true

# Block manual repo renames to maintain config consistency
BLOCK_REPO_RENAME_BY_HUMAN=true
```

### Restricting Scope

Use `deployment-settings.yml` to control which repositories Safe-Settings manages:

```yaml
# deployment-settings.yml

restrictedRepos:
  include:
    - "service-*"
    - "lib-*"
    - "infra-*"
  exclude:
    - admin
    - .github
    - safe-settings
    - "test-*"
    - "sandbox-*"
```

This is particularly useful during phased rollouts — start with a subset of repositories and expand as confidence grows.

---

## Governance Workflows

### Pull Request-Based Policy Changes

All policy changes follow a pull request workflow, providing:

1. **Version control**: Every change to organizational policies is tracked in Git history.
2. **Peer review**: Changes must be approved before taking effect.
3. **Dry-run validation**: Safe-Settings runs in NOP (no-operation) mode on PRs, producing a detailed report of what would change across all affected repositories.
4. **Check runs**: PR checks pass or fail based on dry-run results, including custom validator outcomes.

### CODEOWNERS for Policy Governance

Use GitHub's CODEOWNERS file in the admin repo to establish approval requirements:

```
# CODEOWNERS in admin repo

# Security team must approve all policy changes
.github/settings.yml    @org/security-team @org/platform-leads

# Team leads approve their suborg policies
.github/suborgs/platform-team.yml    @org/platform-leads
.github/suborgs/frontend-team.yml    @org/frontend-leads
.github/suborgs/compliance-critical.yml    @org/compliance-team @org/security-team

# Repo owners can manage their repo-specific settings
.github/repos/api-gateway.yml    @org/api-team
.github/repos/auth-service.yml   @org/identity-team

# Deployment settings require platform admin approval
deployment-settings.yml    @org/platform-admins
```

This enables **delegated governance**: teams can manage their own settings within the guardrails established by the organization baseline and custom validators.

### Change Review Workflow

```
Developer          Admin Repo            Safe-Settings          GitHub
   │                   │                      │                    │
   ├─ Create branch ──►│                      │                    │
   ├─ Modify YAML ────►│                      │                    │
   ├─ Open PR ────────►│                      │                    │
   │                   ├─ Webhook ───────────►│                    │
   │                   │                      ├─ Dry-run ──────────┤
   │                   │                      ├─ Validate rules ───┤
   │                   │                      ├─ Report results ──►│
   │                   │                      │                    │
   │◄──── Review PR with check results ──────────────────────────-│
   │                   │                      │                    │
   ├─ Merge PR ───────►│                      │                    │
   │                   ├─ Push webhook ──────►│                    │
   │                   │                      ├─ Apply settings ──►│
   │                   │                      ├─ Create check ────►│
   │                   │                      │                    │
```

---

## Advanced Policy Controls

### Custom Configuration Validators

Validators allow you to define rules that settings must satisfy before they can be applied. They are defined in `deployment-settings.yml`.

#### Config Validators

Validate a setting in isolation:

```yaml
configvalidators:
  # Prevent granting admin access to collaborators
  - plugin: collaborators
    error: "Admin role cannot be assigned to individual collaborators"
    script: |
      return baseconfig.permission !== 'admin'

  # Ensure all repos have a description
  - plugin: repository
    error: "Repository must have a description"
    script: |
      return baseconfig.description && baseconfig.description.length > 10

  # Validate repository naming conventions
  - plugin: repository
    error: "Repository names must follow the pattern: team-project-component"
    script: |
      const pattern = /^[a-z]+-[a-z]+-[a-z0-9-]+$/
      return pattern.test(baseconfig.name)
```

#### Override Validators

Enforce constraints when lower-level settings override higher-level ones:

```yaml
overridevalidators:
  # Prevent reducing required approvers below the org baseline
  - plugin: branches
    error: "Cannot reduce required approving review count below organization minimum"
    script: |
      if (baseconfig.protection.required_pull_request_reviews.required_approving_review_count &&
          overrideconfig.protection.required_pull_request_reviews.required_approving_review_count) {
        return overrideconfig.protection.required_pull_request_reviews.required_approving_review_count >=
               baseconfig.protection.required_pull_request_reviews.required_approving_review_count
      }
      return true

  # Prevent disabling admin enforcement
  - plugin: branches
    error: "Cannot disable admin enforcement for branch protections"
    script: |
      if (baseconfig.protection.enforce_admins === true) {
        return overrideconfig.protection.enforce_admins !== false
      }
      return true
```

### Disabling Plugins

For scenarios where certain settings should not be managed by Safe-Settings at specific scopes:

```yaml
# At the org level — disable milestones management entirely
disable_plugins:
  - milestones

# At the suborg level — disable labels for matched repos only
disable_plugins:
  - plugin: labels
    target: all
```

**Target options:**

| Target | Effect |
|--------|--------|
| `self` | Strips the plugin from the declaring layer only |
| `children` | Strips from all layers below |
| `all` | Strips from the declaring layer and all layers below |

**Important:** Strips are **union-only** — a lower-level config can add more strips but can never re-enable a plugin disabled at a higher level.

### Additive Plugins

For plugins where you want Safe-Settings to enforce a baseline but allow teams to add their own items without those additions being removed:

```yaml
# In settings.yml — never remove labels or teams added outside safe-settings
additive_plugins:
  - labels
  - teams
  - collaborators
```

In additive mode, Safe-Settings will **add** and **update** entries defined in YAML but will **never delete** items that exist on GitHub but are absent from the configuration. This is ideal for labels, teams, and collaborators where teams may need to add project-specific items.

### Externally Defined Status Checks

For status checks that are managed by CI/CD pipelines rather than Safe-Settings:

```yaml
branches:
  - name: default
    protection:
      required_status_checks:
        contexts:
          - "ci/build"                  # Managed by safe-settings
          - "{{EXTERNALLY_DEFINED}}"    # Preserve any additional checks set via UI
```

This allows Safe-Settings to enforce a minimum set of required status checks while preserving any additional checks configured by teams through the GitHub UI.

---

## Drift Detection and Remediation

### How Drift Is Detected

Drift occurs when repository settings are changed outside of Safe-Settings — for example, a repository administrator modifying branch protections through the GitHub UI.

Safe-Settings detects drift through two mechanisms:

1. **Real-time webhook events**: When certain settings are changed (branch protections, rulesets, team memberships, collaborator changes), GitHub sends webhook events that trigger Safe-Settings to re-sync the affected repository.

2. **Scheduled sync (CRON)**: A configurable cron job that periodically compares all managed repositories against the declared policy and remediates any drift.

### Webhook-Based Remediation

The following events trigger automatic remediation:

- `branch_protection_rule` — Modified or deleted branch protections are restored
- `repository_ruleset` — Unauthorized ruleset changes are reverted
- `member` / `team` changes — Unauthorized permission changes are corrected
- `repository.edited` — Settings like default branch or topics are restored

### Scheduled Sync Configuration

```env
# Run drift detection every hour
CRON=0 * * * *

# Or run at 2 AM daily for lower-priority environments
CRON=0 2 * * *
```

### Drift Remediation Strategy

| Priority | Strategy | Use Case |
|----------|----------|----------|
| **Critical** | Real-time webhook + hourly CRON | Production security policies, branch protections |
| **Standard** | Real-time webhook + daily CRON | Team permissions, labels, general settings |
| **Advisory** | Daily CRON only | Low-risk settings where immediate enforcement isn't required |

---

## Multi-Organization Deployments

For enterprises with multiple GitHub organizations, Safe-Settings can be deployed in several patterns:

### Pattern 1: One App per Organization

Deploy a separate Safe-Settings instance for each organization. Each instance has its own admin repo and configuration.

```
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│   Org: prod-eng  │  │  Org: platform   │  │  Org: open-src   │
│                  │  │                  │  │                  │
│  safe-settings   │  │  safe-settings   │  │  safe-settings   │
│  admin repo      │  │  admin repo      │  │  admin repo      │
│  policies A      │  │  policies B      │  │  policies C      │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

**Advantages:** Complete isolation; different policies per org.  
**Challenges:** Multiple deployments to manage; policy consistency must be maintained manually.

### Pattern 2: Shared Policy Templates

Maintain a shared repository of policy templates and use them as a source for each organization's admin repo:

```
┌─────────────────────────────────────────┐
│        Policy Template Repo             │
│  (Gold-standard YAML templates)         │
└────────┬──────────┬──────────┬──────────┘
         │          │          │
    ┌────▼───┐ ┌────▼───┐ ┌───▼────┐
    │ Org A  │ │ Org B  │ │ Org C  │
    │ admin  │ │ admin  │ │ admin  │
    └────────┘ └────────┘ └────────┘
```

Use CI/CD pipelines (e.g., GitHub Actions) to sync templates to each organization's admin repo, allowing per-org customization while maintaining a consistent baseline.

### Pattern 3: GitHub Enterprise Server + Cloud

For organizations using both GitHub Enterprise Server and GitHub.com:

- Deploy Safe-Settings on-premises for GHES (set `GHE_HOST` environment variable)
- Deploy Safe-Settings in the cloud for GitHub.com organizations
- Use a shared policy template repo to maintain consistency

---

## Security Considerations

### Protecting the Admin Repository

The admin repository is the source of truth for all organizational policies. Protect it with:

1. **Branch protections on the default branch**: Require PR reviews, status checks, and code owner approval.
2. **CODEOWNERS**: Define who can approve changes to different policy files.
3. **Repository visibility**: Keep the admin repo private.
4. **Limited write access**: Only grant write access to authorized policy administrators.
5. **Audit logging**: GitHub's audit log captures all changes to the admin repo.

### GitHub App Permissions

Safe-Settings requires specific permissions to function. Follow the principle of least privilege:

| Permission | Level | Purpose |
|-----------|-------|---------|
| Administration | Read & Write | Manage repository settings |
| Contents | Read & Write | Read config files from admin repo |
| Checks | Read & Write | Report validation results |
| Pull requests | Read & Write | Comment on policy change PRs |
| Custom properties | Read & Write | Manage custom property values |
| Members (org) | Read & Write | Manage team permissions |

### Secrets Management

- **Never** commit the GitHub App private key to the admin repo
- Use environment variables, Kubernetes Secrets, or cloud secret managers (AWS Secrets Manager, Azure Key Vault, HashiCorp Vault)
- Rotate the webhook secret periodically

### Blocking Manual Overrides

Enable `BLOCK_REPO_RENAME_BY_HUMAN=true` to prevent repository renames outside of Safe-Settings, maintaining configuration file consistency.

---

## Case Study: Enterprise Rollout

### Scenario

A financial services company with 3,000+ repositories across 50 development teams needs to enforce SOX compliance controls, standardize branch protections, and reduce the time to provision new repositories from days to minutes.

### Phase 1: Discovery and Planning (Week 1–2)

1. **Audit current state**: Document existing repository configurations across the organization.
2. **Define policy tiers**: Establish three compliance tiers — Standard, Regulated, and Critical.
3. **Map teams to suborgs**: Define suborg membership using custom properties (`compliance_tier: standard|regulated|critical`).
4. **Design CODEOWNERS**: Map approval authority for each policy tier.

### Phase 2: Pilot Deployment (Week 3–4)

1. **Deploy Safe-Settings** to a Kubernetes cluster with the Helm chart.
2. **Restrict scope** to 10 pilot repositories using `deployment-settings.yml`.
3. **Define baseline policies** for organization-wide settings.
4. **Test dry-run mode** by creating PRs and validating check results.
5. **Validate drift remediation** by manually changing settings and confirming automatic reversion.

### Phase 3: Gradual Rollout (Week 5–8)

1. **Expand scope** to one team (50 repositories) per week.
2. **Create suborg policies** for each compliance tier.
3. **Enable override validators** to prevent weakening of security controls.
4. **Train team leads** on creating repo-specific overrides via PR workflow.

### Phase 4: Full Deployment (Week 9–10)

1. **Remove scope restrictions** — Safe-Settings manages all repositories.
2. **Enable scheduled sync** with `CRON=0 * * * *` for hourly drift checks.
3. **Enable `BLOCK_REPO_RENAME_BY_HUMAN`** for configuration consistency.
4. **Document runbooks** for common policy change scenarios.

### Results

| Metric | Before | After |
|--------|--------|-------|
| Time to provision new repo | 2–3 days | < 5 minutes |
| Repos with compliant branch protections | 62% | 100% |
| Manual drift incidents per month | 40+ | 0 (auto-remediated) |
| Policy change audit trail | Partial | Complete (Git history) |
| Time to demonstrate compliance | Days | Minutes (YAML-as-evidence) |

---

## Best Practices

### Policy Design

1. **Keep `settings.yml` minimal — rulesets and custom roles only**: Any change to `settings.yml` triggers processing for every managed repository. To avoid cascading API calls across thousands of repos, limit org-level settings to resources that use org-scoped API endpoints (rulesets and custom repository roles). Move all repo-scoped settings (teams, labels, repository config, collaborators) to suborg files.

2. **Use a broad suborg for repo-scoped baselines**: Create a `baseline.yml` suborg with `suborgrepos: ["*"]` to apply default repo-scoped settings (teams, labels, security config) to all repos. This achieves the same coverage as org-level settings but limits the blast radius of changes to the matched subset.

3. **Use suborgs for team autonomy**: Rather than creating repo-level overrides for every repository, group repos into suborgs by team, project, or compliance tier.

4. **Prefer custom properties for suborg membership**: Custom properties provide the most flexible and maintainable way to group repositories, as they can be updated without modifying the admin repo.

5. **Use additive mode for shared resources**: For labels, teams, and collaborators, consider using `additive_plugins` to allow teams to add project-specific items without those additions being removed on the next sync.

6. **Define validators early**: Establish override validators before teams start creating overrides. This prevents policy weakening from the start.

### Operational Excellence

6. **Protect the admin repo**: Apply the same (or stricter) branch protections to the admin repo as you require for production code.

7. **Use CODEOWNERS strategically**: Grant approval authority at the appropriate level — security team for org settings, team leads for suborg settings, repo owners for repo-specific overrides.

8. **Monitor check runs**: Set up notifications for failed Safe-Settings check runs to catch configuration issues early.

9. **Schedule regular sync**: Even with webhook-based enforcement, configure a CRON schedule as a safety net for missed webhooks.

10. **Version pin your deployment**: Use specific image tags (e.g., `ghcr.io/github/safe-settings:2.1.13`) rather than floating tags to ensure reproducible deployments.

### Scaling

11. **Phase your rollout**: Use `deployment-settings.yml` to gradually expand scope. Start with 10 repos, then 100, then 1,000.

12. **Avoid repo-scoped settings in `settings.yml`**: Changes to `settings.yml` trigger processing for all managed repositories. Keep it to org-level rulesets and custom roles only. Use suborg files for repo-scoped settings to limit the blast radius of any single change.

13. **Use include/exclude patterns**: For teams and collaborators, use `include` and `exclude` patterns rather than defining settings for every repository individually.

14. **Monitor API rate limits**: At scale, watch for rate limit consumption. Probot handles this automatically, but awareness helps with capacity planning.

---

## Conclusion

GitHub Safe-Settings transforms repository governance from a manual, error-prone process into an automated, auditable, and scalable policy-as-code practice. By centralizing configuration in a protected admin repository, enforcing changes through pull request workflows, and continuously remediating drift, organizations can achieve consistent security baselines, streamlined compliance, and empowered development teams.

Whether managing 50 or 5,000 repositories, Safe-Settings provides the flexibility to balance centralized governance with team autonomy — ensuring that every repository in your organization meets your standards, every time.

---

## Additional Resources

- **Repository**: [github/safe-settings](https://github.com/github/safe-settings)
- **Deployment Guide**: [docs/deploy.md](deploy.md)
- **GitHub Actions Guide**: [docs/github-action.md](github-action.md)
- **Sample Settings**: [docs/sample-settings/](sample-settings/)
- **AWS Lambda Template**: [SafeSettings-Template](https://github.com/bheemreddy181/SafeSettings-Template)

---

*© 2026 GitHub, Inc. Safe-Settings is licensed under the [ISC License](https://opensource.org/licenses/ISC).*
