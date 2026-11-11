import { useId, type ReactNode } from "react";

/** Local addresses of the factory's apps, as the launcher and Skidbladnir start them. */
export const FACTORY_ADDRESSES = {
  sindri: "http://127.0.0.1:4310/",
  heimdall: "http://127.0.0.1:4320/",
  mimir: "http://127.0.0.1:7700/",
  skidbladnir: "http://127.0.0.1:4380/",
  feedbackGraph: "http://127.0.0.1:8787/",
} as const;

interface BoxProps {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  lines: string[];
  /** An app with a web UI: drawn in the accent colour and linked to its local address. */
  href?: string;
  dashed?: boolean;
}

function Box({ x, y, w, h, title, lines, href, dashed }: BoxProps) {
  const body = (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={10}
        fill="var(--color-surface)"
        stroke={href ? "var(--color-accent)" : "var(--color-line-strong)"}
        strokeWidth={href ? 1.75 : 1}
        strokeDasharray={dashed ? "5 4" : undefined}
      />
      <text x={x + 12} y={y + 22} fontSize={13} fontWeight={600} fill="var(--color-fg)">
        {title}
      </text>
      {lines.map((line, i) => (
        <text key={line} x={x + 12} y={y + 40 + i * 15} fontSize={11} fill="var(--color-muted)">
          {line}
        </text>
      ))}
    </g>
  );
  if (!href) return body;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${title} at ${href}`}
      style={{ textDecoration: "none" }}
    >
      {body}
    </a>
  );
}

function Edge(props: {
  d: string;
  label?: string;
  lx?: number;
  ly?: number;
  anchor?: "start" | "middle" | "end";
  dashed?: boolean;
  marker: string;
  both?: boolean;
}) {
  return (
    <g>
      <path
        d={props.d}
        fill="none"
        stroke="var(--color-muted)"
        strokeWidth={1.25}
        strokeDasharray={props.dashed ? "4 4" : undefined}
        markerEnd={`url(#${props.marker})`}
        markerStart={props.both ? `url(#${props.marker})` : undefined}
      />
      {props.label && (
        <text
          x={props.lx}
          y={props.ly}
          fontSize={10.5}
          textAnchor={props.anchor ?? "middle"}
          fill="var(--color-muted)"
          paintOrder="stroke"
          stroke="var(--color-canvas)"
          strokeWidth={4}
        >
          {props.label}
        </text>
      )}
    </g>
  );
}

/**
 * How the factory's programs connect, with links to every local web UI. Rendered by the docs for a
 * ```factory-architecture fence; the docs text beside it carries the same facts for screen readers
 * and the Guide.
 */
export function ArchitectureDiagram(): ReactNode {
  const id = useId().replace(/:/g, "");
  const marker = `arch-arrow-${id}`;
  return (
    <figure className="my-4 flex max-w-[1100px] flex-col gap-2">
      <div className="overflow-x-auto rounded-lg border border-line bg-canvas p-2">
        <svg
          viewBox="0 0 760 540"
          role="img"
          aria-labelledby={`${id}-t`}
          aria-describedby={`${id}-d`}
          className="block h-auto w-full min-w-[640px]"
          fontFamily="inherit"
        >
          <title id={`${id}-t`}>How the factory's programs connect</title>
          <desc id={`${id}-d`}>
            You use three web apps in the browser: Sindri plans, Mimir executes and Heimdall watches
            both. Sindri sends an approved plan to Mimir as a mission; Mimir streams events and
            evidence back. Mimir gives each task to an agent in its own git worktree, and Brokkr
            verifies the result. Sindri reads lessons from Feedback Graph and asks Claude Code to
            draft specs and plans. Skidbladnir can supply worker machines. The launcher starts
            Sindri, Mimir and Heimdall together.
          </desc>
          <defs>
            <marker
              id={marker}
              viewBox="0 0 10 10"
              refX={9}
              refY={5}
              markerWidth={7}
              markerHeight={7}
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" fill="var(--color-muted)" />
            </marker>
          </defs>

          {/* You */}
          <Box x={290} y={14} w={180} h={44} title="You · in the browser" lines={[]} />
          <Edge d="M380,58 L380,96" marker={marker} />
          <Edge
            d="M290,40 L245,40 L245,226"
            marker={marker}
            label="open directly"
            lx={245}
            ly={30}
            dashed
          />
          <Edge
            d="M470,40 L515,40 L515,226"
            marker={marker}
            label="open directly"
            lx={515}
            ly={30}
            dashed
          />

          {/* Row 1: launcher, Heimdall, Skidbladnir */}
          <Box
            x={20}
            y={96}
            w={200}
            h={70}
            title="Launcher"
            lines={["Start Factory.command starts", "Sindri, Mimir and Heimdall"]}
            dashed
          />
          <Box
            x={270}
            y={96}
            w={220}
            h={86}
            title="Heimdall · :4320"
            lines={["Watches Sindri and Mimir;", "acts with the operator code", "(command center)"]}
            href={FACTORY_ADDRESSES.heimdall}
          />
          <Box
            x={540}
            y={96}
            w={200}
            h={70}
            title="Skidbladnir · :4380"
            lines={["Worker machines, simulated", "or cloud (optional; has MCP)"]}
            href={FACTORY_ADDRESSES.skidbladnir}
          />

          {/* Row 2: Sindri and Mimir */}
          <Box
            x={20}
            y={226}
            w={240}
            h={104}
            title="Sindri · :4310 (plans)"
            lines={[
              "Inbox, Director, specs, plans,",
              "runs, quality gates, deliveries,",
              "knowledge and the steward",
              "Live: SSE /v1/changes",
            ]}
            href={FACTORY_ADDRESSES.sindri}
          />
          <Box
            x={500}
            y={226}
            w={240}
            h={104}
            title="Mimir · :7700 (executes)"
            lines={[
              "Missions, crews, agents,",
              "approvals, budgets and",
              "every event, recorded",
              "Live: event stream",
            ]}
            href={FACTORY_ADDRESSES.mimir}
          />
          <Edge d="M330,182 L230,226" marker={marker} both />
          <Edge d="M430,182 L530,226" marker={marker} both />
          <text x={380} y={216} fontSize={10.5} textAnchor="middle" fill="var(--color-muted)">
            reads both every 3 s · sends your actions
          </text>
          <Edge d="M640,166 L640,226" marker={marker} both label="workers" lx={668} ly={200} />
          <Edge d="M120,166 L120,226" marker={marker} dashed />
          <Edge
            d="M260,262 L500,262"
            marker={marker}
            label="approved plan → mission (HTTP)"
            lx={380}
            ly={254}
          />
          <Edge
            d="M500,298 L260,298"
            marker={marker}
            label="events and evidence (stream)"
            lx={380}
            ly={316}
          />

          {/* Row 3: helpers */}
          <Box
            x={20}
            y={380}
            w={150}
            h={70}
            title="Director & planner"
            lines={["Claude Code CLI drafts", "specs and plans"]}
          />
          <Box
            x={186}
            y={380}
            w={190}
            h={70}
            title="Feedback Graph · :8787"
            lines={["Approved lessons;", "Sindri only reads"]}
            href={FACTORY_ADDRESSES.feedbackGraph}
            dashed
          />
          <Box
            x={424}
            y={380}
            w={150}
            h={70}
            title="Agents"
            lines={["Codex or Claude Code,", "each in its own worktree"]}
          />
          <Box
            x={590}
            y={380}
            w={150}
            h={70}
            title="Brokkr"
            lines={["Verifies each result;", "signed report + verdict"]}
          />
          <Edge d="M95,330 L95,380" marker={marker} />
          <Edge
            d="M262,380 L215,330"
            marker={marker}
            label="lessons"
            lx={262}
            ly={360}
            anchor="start"
          />
          <Edge d="M560,330 L510,380" marker={marker} label="task" lx={508} ly={360} anchor="end" />
          <Edge
            d="M665,380 L665,330"
            marker={marker}
            label="verdict"
            lx={672}
            ly={360}
            anchor="start"
          />
          <Edge d="M574,415 L590,415" marker={marker} />

          {/* Row 4: the repository */}
          <Box
            x={20}
            y={480}
            w={720}
            h={46}
            title="Your git repository"
            lines={[
              "Sindri reads it to plan · agents change copies in worktrees · you export the delivery's patch and apply it",
            ]}
          />
          <Edge d="M499,450 L499,480" marker={marker} both />
          <Edge d="M140,450 L140,480" marker={marker} />
        </svg>
      </div>
      <figcaption className="text-sm text-muted">
        Boxes with a highlighted border are web apps: select one to open it. Dashed boxes are
        optional or start the others.
      </figcaption>
    </figure>
  );
}
