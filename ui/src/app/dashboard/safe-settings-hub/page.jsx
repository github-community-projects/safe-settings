import TitleBar from "../../components/TitleBar";
import MasterAdminContents from "../../components/Safe-settings-hubContent";

export default function SafeSettingsHubConfigPage() {
  return (
    <div>
      <TitleBar />
      <main className="container mt-4">
        <div className="theme-bg-primary p-4 rounded theme-border border">
          <h2 className="theme-text-primary mb-3">
            Safe-Settings Hub Content
          </h2>
          <p className="theme-text-secondary">
            Listing files maintained by the Safe-Settings Global configuration (all ORG's).
            Files are retrieved from `/api/safe-settings/hub/content`.
          </p>
        </div>
        <br />
        <div className="theme-bg-primary p-4 rounded theme-border border">
          <MasterAdminContents />
        </div>
      </main>
    </div>
  );
}
