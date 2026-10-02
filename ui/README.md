This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/route.ts`. The page auto-updates as you edit the file.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## API Routes

This directory contains example API routes for the headless API app.

For more details, see [route.js file convention](https://nextjs.org/docs/app/api-reference/file-conventions/route).

---

```mermaid

sequenceDiagram
    participant User
    participant OrganizationsTable.jsx
    participant HubOrgGraph.jsx
    participant Next.js API Proxy
    participant Backend (Express)
    participant GitHub API

    User->>OrganizationsTable.jsx: Loads Organization page
    OrganizationsTable.jsx->>Next.js API Proxy: GET /api/safe-settings/installation
    Next.js API Proxy->>Backend (Express): GET /api/safe-settings/installation
    Backend (Express)->>GitHub API: Fetch org installations, repo status, commit info, sync status
    GitHub API-->>Backend (Express): Returns org data
    Backend (Express)-->>Next.js API Proxy: Returns installations array
    Next.js API Proxy-->>OrganizationsTable.jsx: Returns installations array
    OrganizationsTable.jsx->>HubOrgGraph.jsx: Passes org data (hasConfigRepo, isInSync)
    HubOrgGraph.jsx->>Next.js API Proxy: (if fetching own data) GET /api/safe-settings/installation
    Next.js API Proxy->>Backend (Express): GET /api/safe-settings/installation
    Backend (Express)->>GitHub API: (repeat fetch if needed)
    GitHub API-->>Backend (Express): Returns org data
    Backend (Express)-->>Next.js API Proxy: Returns installations array
    Next.js API Proxy-->>HubOrgGraph.jsx: Returns installations array
    User->>OrganizationsTable.jsx: Interacts with table/graph (tooltips, legend, etc.)
```