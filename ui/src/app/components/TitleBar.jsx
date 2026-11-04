"use client";
import {
    GearIcon,
    GlobeIcon,
    ListUnorderedIcon,
    MoonIcon,
    NoteIcon,
    SunIcon,
} from "@primer/octicons-react";
import { usePathname } from "next/navigation";
import { withBasePath } from "../utils/basePath";
import { useTheme } from "./ThemeContext";
import "./TitleBar.css";

export default function TitleBar() {
  const pathname = usePathname();
  const { isDark, toggleTheme } = useTheme();

  // Always render the TitleBar structure to prevent layout shift
  return (
    <>
      <header
        className={`shadow-sm title-header ${
          isDark ? "text-light" : "text-white"
        }`}
      >
        <div className="container-fluid d-flex align-items-center py-2">
          <span className="fs-5 text-white d-flex align-items-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="22"
              height="22"
              fill="currentColor"
              viewBox="0 0 16 16"
              className="me-2"
            >
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.01.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.11.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
            </svg>
            <a
              href={withBasePath("/dashboard")}
              className="text-decoration-none"
              style={{ color: "inherit" }}
            >
              Safe-Settings Hub Dashboard
            </a>
          </span>
          <div className="ms-auto d-flex align-items-center">
            <button
              className="btn btn-sm btn-outline-light theme-toggle-btn"
              onClick={toggleTheme}
              aria-label="Toggle theme"
            >
              <span className="theme-toggle-icon">
                {isDark ? <SunIcon size={18} /> : <MoonIcon size={18} />}
              </span>
            </button>
          </div>
        </div>
      </header>
      <nav className="title-nav">
        <div className="container-fluid d-flex align-items-center">
          <ul className="nav nav-tabs mb-0">
            <li className="nav-item">
              <a
                className={`nav-link fw-light d-flex align-items-center position-relative menu-hover nav-link-custom${
                  isDark ? " dark-font" : " light-font"
                }`}
                href={withBasePath("/dashboard/safe-settings-hub")}
              >
                <span className="me-1">
                  <GlobeIcon size={16} />
                </span>
                Safe-Settings Hub
                {pathname === "/dashboard/safe-settings-hub" && (
                  <span className="menu-active-indicator"></span>
                )}
              </a>
            </li>
            <li className="nav-item">
              <a
                className={`nav-link fw-light d-flex align-items-center position-relative menu-hover nav-link-custom${
                  isDark ? " dark-font" : " light-font"
                }`}
                href={withBasePath("/dashboard/organizations")}
              >
                <span className="me-1">
                  <ListUnorderedIcon size={16} />
                </span>
                Organizations
                {pathname === "/dashboard/organizations" && (
                  <span className="menu-active-indicator"></span>
                )}
              </a>
            </li>
            <li className="nav-item">
              <a
                className={`nav-link fw-light d-flex align-items-center position-relative menu-hover nav-link-custom${
                  isDark ? " dark-font" : " light-font"
                }`}
                href={withBasePath("/dashboard/env")}
              >
                <span className="me-1">
                  <GearIcon size={16} />
                </span>
                Environment
                {pathname === "/dashboard/env" && (
                  <span className="menu-active-indicator"></span>
                )}
              </a>
            </li>
            <li className="nav-item">
              <a
                className={`btn btn-sm ms-auto nav-link fw-light d-flex position-relative menu-hover nav-link-custom${
                  isDark ? " dark-font" : " light-font"
                }`}
                href={withBasePath("/dashboard/help")}
              >
                <span className="me-1">
                  <NoteIcon size={16} />
                </span>
                About
                {pathname === "/dashboard/help" && (
                  <span className="menu-active-indicator"></span>
                )}
              </a>
            </li>
            <li className="nav-item">
              <a
                className={`btn btn-sm ms-auto nav-link fw-light d-flex position-relative menu-hover nav-link-custom${
                  isDark ? " dark-font" : " light-font"
                }`}
                href={withBasePath("/dashboard/logs")}
              >
                <span className="me-1">
                  <NoteIcon size={16} />
                </span>
                Sync-Logs
                {pathname === "/dashboard/logs" && (
                  <span className="menu-active-indicator"></span>
                )}
              </a>
            </li>
          </ul>
        </div>
      </nav>
    </>
  );
}
