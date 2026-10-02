# URL Prefix Configuration

Safe Settings supports deployment behind a reverse proxy (like NGINX) that routes to the application using a custom URL prefix.

## Overview

By default, Safe Settings serves its UI and API from `/safe-settings`:
- Dashboard: `http://localhost:3000/safe-settings/dashboard`
- API: `http://localhost:3000/safe-settings/api/safe-settings/...`

You can customize this by setting the `SAFE_SETTINGS_HUB_URL_PREFIX` environment variable, or set it to an empty string for root path deployment:
- Dashboard (root): `http://localhost:3000/dashboard`
- API (root): `http://localhost:3000/api/safe-settings/...`

## Configuration

### Default Behavior

Safe Settings defaults to `SAFE_SETTINGS_HUB_URL_PREFIX=/safe-settings`. No configuration needed for this default.

### Customizing the URL Prefix

To use a different URL prefix, add to your `.env` file:

```bash
SAFE_SETTINGS_HUB_URL_PREFIX=/my-custom-path
```

### Root Path Deployment

To deploy at the root path instead, set SAFE_SETTINGS_HUB_URL_PREFIX to an empty string:

```bash
SAFE_SETTINGS_HUB_URL_PREFIX=
```

**Important:** 
- The SAFE_SETTINGS_HUB_URL_PREFIX will automatically add a leading `/` if you forget it
- Examples: `/safe-settings`, `safe-settings`, `/apps/safe-settings`, `custom-prefix` (all work!)
- Do NOT end with `/`
- Set to empty string or `/` for root path deployment

### 2. Rebuild the UI

After changing the SAFE_SETTINGS_HUB_URL_PREFIX, you must rebuild the Next.js UI:

```bash
cd ui
npm run build
cd ..
```

### 3. Restart the application

```bash
npm start
# or
npm run dev
```

## NGINX Configuration Example

Here's an example NGINX configuration for routing requests to Safe Settings at `/safe-settings`:

Make sure to set `SAFE_SETTINGS_HUB_URL_PREFIX=/safe-settings` in your `.env` file before starting the application.

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # Route /safe-settings to Safe Settings application
    location /safe-settings {
        proxy_pass http://localhost:3000/safe-settings;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # Route other paths to different applications
    location /other-app {
        proxy_pass http://localhost:4000;
        # ... other proxy settings
    }
}
```

## How It Works

The SAFE_SETTINGS_HUB_URL_PREFIX configuration affects three layers:

1. **Backend Routing** (`lib/routes.js`): Express router is mounted at the SAFE_SETTINGS_HUB_URL_PREFIX instead of root
2. **Next.js Configuration** (`ui/next.config.js`): The `basePath` setting tells Next.js to generate assets with the correct URL prefix
3. **Frontend Links & API Calls** (`ui/src/app/**`): Navigation links and API fetch calls use the `withBasePath()` utility to prepend the URL prefix

All API endpoints in the frontend components (`EnvVariables.jsx`, `OrganizationsTable.jsx`, `Safe-settings-hubContent.jsx`, `HubOrgGraph.jsx`) have been updated to use `withBasePath()` for proper routing.

## Testing Locally

To test the default SAFE_SETTINGS_HUB_URL_PREFIX locally without NGINX:

1. No configuration needed (defaults to `/safe-settings`)
2. Build UI: `cd ui && npm run build && cd ..`
3. Start app: `npm run dev`
4. Access at: `http://localhost:3000/safe-settings/dashboard`

To test a custom SAFE_SETTINGS_HUB_URL_PREFIX:

1. Set `SAFE_SETTINGS_HUB_URL_PREFIX=/your-path` in `.env`
2. Rebuild UI: `cd ui && npm run build && cd ..`
3. Start app: `npm run dev`
4. Access at: `http://localhost:3000/your-path/dashboard`

## Troubleshooting

### Assets not loading
- Make sure you rebuilt the UI after changing SAFE_SETTINGS_HUB_URL_PREFIX
- Check browser console for 404 errors
- Verify NGINX is correctly proxying all paths under the URL prefix

### API calls failing
- Ensure your proxy passes the full path including SAFE_SETTINGS_HUB_URL_PREFIX
- Check that relative API URLs are being used (not absolute URLs)

### Navigation broken
- Verify all `<a>` tags use `withBasePath()` utility
- Check that `pathname` comparisons account for the URL prefix

## Deploying at Root Path

To deploy at root path instead of the default `/safe-settings`:

1. Set `SAFE_SETTINGS_HUB_URL_PREFIX=` (empty string) in `.env`
2. Rebuild UI: `cd ui && npm run build && cd ..`
3. Restart application
4. Access at: `http://localhost:3000/dashboard`
