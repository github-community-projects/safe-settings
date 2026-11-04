"use client";
import TitleBar from "./components/TitleBar";
import { withBasePath } from "./utils/basePath";

export default function NotFound() {
  return (
    <div>
      <TitleBar />
      <main className="container mt-4 text-center">
        <h1 className="display-4">404</h1>
        <p className="lead">Sorry, the page you are looking for does not exist.</p>
        <a href={withBasePath("/dashboard")} className="btn btn-primary mt-3">Go to Dashboard</a>
      </main>
    </div>
  );
}
