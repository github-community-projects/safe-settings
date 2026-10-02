import TitleBar from "../../components/TitleBar";
import OrganizationsTable from "../../components/OrganizationsTable";

export default function OrganizationsPage() {
  return (
    <div>
      <TitleBar />
      <main className="container mt-4">
        <div className="theme-bg-primary p-4 rounded mb-4 theme-border border">
          <h2 className="theme-text-primary mb-3">
            Organizations
          </h2>
          <p className="theme-text-secondary">
            List all the Organizations where the Safe-Settings App is installed and the last time Safe-settings configurations were synced.
          </p>
        </div>

        <div className="theme-bg-primary p-4 rounded theme-border border">
          <OrganizationsTable />
        </div>
      </main>
    </div>
  );
}
