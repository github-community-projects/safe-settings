import TitleBar from "../../components/TitleBar";
import EnvVariables from "../../components/EnvVariables";

export default function EnvVarsPage() {
  return (
    <div>
      <TitleBar />
      <main className="container mt-4">
        <div className="theme-bg-primary p-4 rounded theme-border border">
          <h2 className="theme-text-primary mb-3">App Environment Settings</h2>
          <p className="theme-text-secondary mb-4">
            These are the current settings used by the app. Some values are hidden or
            masked for security.
          </p>
        </div>
        <br />
        <div className="theme-bg-primary p-4 rounded theme-border border">
          <EnvVariables />
        </div>
      </main>
    </div>
  );
}
