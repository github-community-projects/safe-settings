# AWS Lambda Deployment Guide

This guide covers deploying safe-settings to AWS Lambda using Docker containers with automated GitHub Actions deployment.

## Overview

`safe-settings` can be deployed to AWS Lambda using a containerized approach that provides:

- **Docker-based deployment** using the official Safe Settings source
- **Dual Lambda functions** for webhooks and scheduled sync operations
- **GitHub Actions CI/CD** with automated testing and deployment
- **Production-ready architecture** with proper error handling and monitoring

## Template Repository

For a complete working example, use the [SafeSettings-Template](https://github.com/bheemreddy181/SafeSettings-Template) repository. This template provides:

- **🏗️ Modular Architecture** - Clean separation with utility modules
- **🧪 Comprehensive Testing** - Unit tests with coverage reporting  
- **🚀 Automated CI/CD** - GitHub Actions for testing, building, and deployment
- **📊 Smart Routing** - Handles both GitHub webhooks and scheduled sync operations
- **🐳 Containerized** - Uses official Safe Settings source with Lambda adapter
- **⚡ Serverless** - Pay only for execution time, auto-scaling included

**To get started**: Click "Use this template" on the repository page to create your own deployment.

## Architecture

The template uses a **dual Lambda function architecture**:

- **`safe-settings-lambda`**: Handles GitHub webhook events via Function URL
- **`safe-settings-scheduler`**: Handles scheduled sync operations via EventBridge
- **Shared Docker Image**: Both functions use the same container with different entry points
- **Smart Handler Routing**: Automatically routes events to appropriate handlers

## Prerequisites

- AWS Account with ECR and Lambda access
- GitHub repository with Actions enabled
- **Node.js 20+ (Latest LTS recommended)** for local development
- npm 10+ (comes with Node.js 20+)
- GitHub App created with proper permissions

## Quick Setup

### 1. Use the Template

1. Go to [SafeSettings-Template](https://github.com/bheemreddy181/SafeSettings-Template)
2. Click **"Use this template"** button
3. Create a new repository in your organization
4. Clone your new repository locally

### 2. AWS Infrastructure Setup

Create the required AWS resources:

```bash
# Create ECR repository
aws ecr create-repository --repository-name safe-settings-lambda --region YOUR_AWS_REGION

# Create main Lambda function for webhooks
aws lambda create-function \
  --function-name safe-settings-lambda \
  --code ImageUri=YOUR_ACCOUNT.dkr.ecr.YOUR_AWS_REGION.amazonaws.com/safe-settings-lambda:latest \
  --role arn:aws:iam::YOUR_ACCOUNT:role/lambda-execution-role \
  --package-type Image \
  --timeout 30 \
  --memory-size 512 \
  --image-config '{"Command":["safe-settings-handler.webhooks"]}'

# Create scheduler Lambda function (same image, different handler)
aws lambda create-function \
  --function-name safe-settings-scheduler \
  --code ImageUri=YOUR_ACCOUNT.dkr.ecr.YOUR_AWS_REGION.amazonaws.com/safe-settings-lambda:latest \
  --role arn:aws:iam::YOUR_ACCOUNT:role/lambda-execution-role \
  --package-type Image \
  --timeout 60 \
  --memory-size 512 \
  --image-config '{"Command":["safe-settings-handler.scheduler"]}'

# Create Function URL for GitHub webhooks
aws lambda create-function-url-config \
  --function-name safe-settings-lambda \
  --auth-type NONE \
  --cors '{"AllowOrigins":["*"],"AllowMethods":["POST"]}'
```

### 3. GitHub Configuration

#### Repository Variables
Configure these in your GitHub repository settings → Variables:

```
AWS_REGION=your-aws-region
AWS_ACCOUNT_ID=your-aws-account-id
ECR_REPOSITORY=safe-settings-lambda
LAMBDA_FUNCTION_NAME=safe-settings-lambda
SCHEDULER_FUNCTION_NAME=safe-settings-scheduler
GH_ORG=your-organization
APP_ID=your-github-app-id
WEBHOOK_SECRET=your-webhook-secret
SAFE_SETTINGS_GITHUB_CLIENT_ID=your-client-id
```

#### Repository Secrets
Configure these in your GitHub repository settings → Secrets:

```
PRIVATE_KEY=your-github-app-private-key
SAFE_SETTINGS_GITHUB_CLIENT_SECRET=your-client-secret
```

### 4. Deploy

Push to the `master` branch to trigger automatic deployment:

```bash
git push origin master
```

The GitHub Actions workflow will:
1. Run tests and generate coverage reports
2. Build the Docker image using multi-stage build
3. Push to ECR with SHA and latest tags
4. Update both Lambda functions
5. Configure environment variables

## Local Development

### Project Structure

The template includes:

```
├── safe-settings-handler.js     # Main Lambda handler with smart routing
├── utils/
│   └── keyUtils.js              # Private key validation & normalization
├── tests/
│   ├── keyUtils.test.js         # Unit tests for key utilities
│   └── simple-integration.test.js # Integration tests
├── .github/workflows/
│   ├── test.yml                 # CI/CD pipeline for testing & building
│   └── deploy_to_lambda.yml     # Production deployment workflow
├── Dockerfile                   # Multi-stage Lambda container build
└── package.json                 # Dependencies & test configuration
```

### Handler Logic

The main handler intelligently routes events:

```javascript
// EventBridge scheduled events → Scheduler handler
if (event.source === 'aws.events' || event.sync === true) {
  return await schedulerHandler(event, context)
}

// GitHub webhooks → Webhook handler  
return await webhookHandler(event, context)
```

### Running Tests

```bash
# Install dependencies
npm install

# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode for development
npm run test:watch

# Run specific test file
npx jest tests/keyUtils.test.js
```

## Scheduling Sync Operations

Set up EventBridge to trigger periodic syncs:

```bash
# Create EventBridge rule for scheduled sync
aws events put-rule \
  --name safe-settings-sync-schedule \
  --schedule-expression "rate(5 minutes)"

# Add Lambda target (scheduler function)
aws events put-targets \
  --rule safe-settings-sync-schedule \
  --targets "Id"="1","Arn"="arn:aws:lambda:YOUR_AWS_REGION:YOUR_ACCOUNT:function:safe-settings-scheduler"

# Grant EventBridge permission to invoke Lambda
aws lambda add-permission \
  --function-name safe-settings-scheduler \
  --statement-id allow-eventbridge \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn arn:aws:events:YOUR_AWS_REGION:YOUR_ACCOUNT:rule/safe-settings-sync-schedule
```

### Manual Sync

Trigger a manual sync operation:

```bash
# Invoke with sync flag
aws lambda invoke \
  --function-name safe-settings-lambda \
  --payload '{"sync": true}' \
  response.json
```

## Container Architecture

The template uses a **multi-stage Docker build**:

1. **Stage 1**: Copies the official Safe Settings source from `ghcr.io/github-community-projects/safe-settings:3.0.0`
2. **Stage 2**: Creates Lambda runtime with Node.js 20, adds the Probot Lambda adapter, and includes the custom handler

Both Lambda functions use the same Docker image but with different entry points:
- **Webhook function**: `safe-settings-handler.webhooks`
- **Scheduler function**: `safe-settings-handler.scheduler`

## Features

### Smart Handler Routing
- **Webhook Handler**: Processes GitHub webhook events using Probot
- **Scheduler Handler**: Handles EventBridge scheduled sync operations
- **Development Support**: Includes mock functionality for local testing
- **Error Handling**: Comprehensive error logging with request IDs

### Testing & Quality
- **Unit Tests**: Jest-based test suite with coverage reporting
- **Integration Tests**: Validates module loading and file structure
- **CI/CD Pipeline**: Automated testing on every PR and push
- **Security Scanning**: Automated security audits and secret detection

## Monitoring

### CloudWatch Logs

Monitor Lambda execution:

```bash
# View recent logs (replace with your function name)
aws logs tail /aws/lambda/safe-settings-lambda --follow

# Filter for errors
aws logs filter-log-events \
  --log-group-name /aws/lambda/safe-settings-lambda \
  --filter-pattern "ERROR"
```

### GitHub Actions

Monitor deployments and test results in the Actions tab of your repository. Each PR will automatically:

- Run tests on Node.js 20
- Generate coverage reports
- Comment with test results
- Validate Docker builds
- Run security audits

## Troubleshooting

### Common Issues

1. **Module not found errors**: Ensure `utils/` directory is included in Dockerfile
2. **Environment variables**: Verify all required secrets are set in GitHub repository settings
3. **Permissions**: Check IAM roles have ECR and Lambda access
4. **Webhook URL**: Use the Lambda Function URL as your GitHub App webhook URL
5. **Docker build failures**: Check that the base image `ghcr.io/github-community-projects/safe-settings:3.0.0` is accessible

### Debug Mode

Enable debug logging by setting `LOG_LEVEL=debug` in the Lambda environment variables.

### Template-Specific Issues

- **Handler routing**: Verify the handler commands are correctly set:
  - Webhook function: `safe-settings-handler.webhooks`
  - Scheduler function: `safe-settings-handler.scheduler`
- **GitHub Actions failures**: Check that all required repository variables and secrets are configured
- **ECR push failures**: Ensure AWS credentials have ECR push permissions

## Template Features

✅ **Production Ready**: Battle-tested deployment pattern  
✅ **Fully Generic**: No organization-specific code  
✅ **Comprehensive Documentation**: Step-by-step setup guide  
✅ **CI/CD Included**: GitHub Actions workflows  
✅ **Local Development**: Mock implementation for testing  
✅ **Multi-Environment**: Template supports staging/production  
✅ **Security Focused**: IAM roles, secrets management  
✅ **Monitoring Ready**: CloudWatch integration  

## Support

For template-specific issues:
- Check the [SafeSettings-Template repository](https://github.com/bheemreddy181/SafeSettings-Template) for updates
- Review GitHub Actions logs for deployment failures
- Verify AWS resource configuration matches the template requirements

For general safe-settings issues, refer to the main [README](../README.md) and [deployment guide](deploy.md).