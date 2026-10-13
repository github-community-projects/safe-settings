'use client';
import { useEffect, useRef } from "react";
import useSWR from "swr";
import { withBasePath } from "../utils/basePath";

const fetcher = (...args) => fetch(...args).then(res => {
  if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
  return res.json();
});

export default function HubOrgGraph({ width = 640, height = 320 }) {
  const vizRef = useRef(null);
  const { data, error } = useSWR(withBasePath("/api/safe-settings/installation"), fetcher);
  const orgs = Array.isArray(data?.installations)
    ? data.installations.filter(i => i.type === "Organization")
    : [];
  const orgCount = orgs.length;

  useEffect(() => {
    if (typeof window === "undefined" || !data) return;
    Promise.all([
      import("d3-selection"),
      import("d3-force"),
      import("d3-drag")
    ]).then(([d3Selection, d3Force, d3Drag]) => {
      const select = d3Selection.select;
      const forceSimulation = d3Force.forceSimulation;
      const forceLink = d3Force.forceLink;
      const forceManyBody = d3Force.forceManyBody;
      const forceCenter = d3Force.forceCenter;
      const drag = d3Drag.drag;
      // Dynamic graph data: 1 HUB, N ORGs
      const nodes = [ { id: "Hub", group: 1, label: "Hub", color: "#0a2540" } ];
      if (orgs.length > 0) {
        orgs.forEach((org, i) => {
          const orgKey = org.account;
          const hasConfigRepo = org.hasConfigRepo === true;
          nodes.push({ id: orgKey, group: 2, label: "ORG", color: hasConfigRepo ? "#2ea44f" : "#6a737d", tooltip: org.account });
        });
      } else {
        for (let i = 1; i <= orgCount; i++) {
          nodes.push({ id: `ORG${i}`, group: 2, label: "ORG", color: "#6a737d", tooltip: `ORG${i}` });
        }
      }
      const links = [];
      if (orgs.length > 0) {
        orgs.forEach((org, i) => {
          const orgKey = org.account;
          links.push({ source: "Hub", target: orgKey });
        });
      } else {
        for (let i = 1; i <= orgCount; i++) {
          links.push({ source: "Hub", target: `ORG${i}` });
        }
      }
      select(vizRef.current).selectAll("svg").remove();
      const svg = select(vizRef.current)
        .append("svg")
        .attr("width", width)
        .attr("height", height);
      const simulation = forceSimulation(nodes)
        .force("link", forceLink(links).id(d => d.id).distance(120))
        .force("charge", forceManyBody().strength(-400))
        .force("center", forceCenter(width / 2, height / 2));
      const link = svg.append("g")
        .attr("stroke", "#999")
        .attr("stroke-opacity", 0.6)
        .selectAll("line")
        .data(links)
        .join("line")
        .attr("stroke-width", 2);
      const node = svg.append("g")
        .attr("stroke", "#fff")
        .attr("stroke-width", 2)
        .selectAll("circle")
        .data(nodes)
        .join("circle")
        .attr("r", 24)
        .attr("fill", d => d.group === 1 ? d.color : d.color || "#6f42c1")
        .call(drag()
          .on("start", (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x; d.fy = d.y;
          })
          .on("drag", (event, d) => {
            d.fx = event.x; d.fy = event.y;
          })
          .on("end", (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null; d.fy = null;
          })
        );
      node.append("title")
        .text(d => d.group === 2 ? d.tooltip : "Hub");
      const label = svg.append("g")
        .selectAll("text")
        .data(nodes)
        .join("text")
        .attr("text-anchor", "middle")
        .attr("dy", ".35em")
        .attr("font-size", 16)
        .attr("font-family", "sans-serif")
        .attr("fill", d => d.group === 1 ? "#fff" : "#fff")
        .text(d => d.label)
        .each(function(d) {
          d3Selection.select(this)
            .append("title")
            .text(d.group === 2 ? d.tooltip : "Hub");
        });
      simulation.on("tick", () => {
        link
          .attr("x1", d => d.source.x)
          .attr("y1", d => d.source.y)
          .attr("x2", d => d.target.x)
          .attr("y2", d => d.target.y);
        node
          .attr("cx", d => d.x)
          .attr("cy", d => d.y);
        label
          .attr("x", d => d.x)
          .attr("y", d => d.y);
      });
    });
  }, [width, height, orgCount, data]);

  if (error) return <div className="text-danger">Error loading organization graph.</div>;
  if (!data) return <div className="text-muted">Loading organization graph...</div>;

  return (
    <div style={{ width: "100%", maxWidth: width }}>
      <div ref={vizRef} style={{ height }} />
      <div style={{ display: "flex", alignItems: "center", gap: "2rem", marginTop: "1rem" }}>
        <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <svg width="24" height="24"><circle cx="12" cy="12" r="10" fill="#2ea44f" stroke="#fff" strokeWidth="2" /></svg>
          <span style={{ fontSize: 14 }}>Has safe-settings admin repo</span>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <svg width="24" height="24"><circle cx="12" cy="12" r="10" fill="#6a737d" stroke="#fff" strokeWidth="2" /></svg>
          <span style={{ fontSize: 14 }}>No safe-settings admin repo</span>
        </span>
      </div>
    </div>
  );
}
