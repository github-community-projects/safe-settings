import TitleBar from "../components/TitleBar";
import { AlertIcon, ArrowRightIcon, CheckCircleIcon, GitCommitIcon, GitPullRequestIcon, GitMergeIcon, EyeIcon } from "@primer/octicons-react";

export default function DashboardPage() {
  return (
    <div>
      <TitleBar />
      <main className="container mt-4 main">
        <h2>Welcome to the Safe-Settings Hub Dashboard</h2>
        <p>Select a menu item above to get started.</p>
        <p>
          This dashboard is a read-first reporting interface that displays configuration state and sync activity status for the Safe-Settings Hub. <br />
          <br /><AlertIcon size={16} /> It is not intended as the workflow for editing Safe-Settings Hub configuration content.<br /><br />

          <br />To make changes, please use the standard GitHub process for content updates:<br /><br /><br />
          <GitCommitIcon size={16} /> Commit &nbsp;&nbsp;&nbsp;<ArrowRightIcon size={16} />&nbsp;&nbsp;&nbsp;
          <GitPullRequestIcon size={16} /> Pull Request &nbsp;&nbsp;&nbsp;<ArrowRightIcon size={16} />&nbsp;&nbsp;&nbsp;
          <EyeIcon size={16} /> Approve &nbsp;&nbsp;&nbsp;<ArrowRightIcon size={16} />&nbsp;&nbsp;&nbsp;
          <GitMergeIcon size={16} /> Merge  &nbsp;&nbsp;&nbsp;<ArrowRightIcon size={16} /> &nbsp;&nbsp;&nbsp; <CheckCircleIcon size={16} />
          
        </p>
      </main>
    </div>
  );
}
