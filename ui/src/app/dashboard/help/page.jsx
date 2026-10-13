'use client';

import TitleBar from "../../components/TitleBar";
import Link from "next/link";
import HubOrgGraph from "../../components/HubOrgGraph";

export default function HelpPage() {
  return (
    <div>
      <TitleBar />
      <main className="container mt-4 main">
        <h2>Dashboard & Hub - Help</h2>
        <p className="lead">Quick guidance for the Safe-Settings Dashboard and Hub.</p>
        <HubOrgGraph width={640} height={320} className="mb-4" />
        <br /><br />
        <h3>What is the Safe-Settings Dashboard</h3>
        <p>
          This UI provides status information for the Safe-Settings Hub feature. It is a read-first reporting and status tool that displays configuration state and import/sync status.
        </p>
        <h3>How to get started</h3>
        <p>
          The Organizations page lists every Org where the Safe-Settings Hub is installed. You can use the Retrieve Settings button to perform an initial import from the selected organizations' config repositories. It reads files from the configured <code>CONFIG_PATH</code> in each organization's config repo and commits them into a single branch in the hub repository, then opens a pull request for review. This is intended for initial population or one-time imports — the action will skip organizations that already have content in the hub path.
        </p>
        <h3>How to edit configuration</h3>
        <p>
          The dashboard is not a content editor. To change configuration you should edit files in your admin repository and follow the normal GitHub workflow: commit changes, open a pull request, get required approvers to review, and merge. After the PR is merged the dashboard will reflect the updated state.
        </p>
        <hr />
        <p className="text-muted small">
          If you need more help, check the repository documentation or contact the maintainers.
        </p>
      </main>
    </div>
  );
}
