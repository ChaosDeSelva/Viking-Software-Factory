import { useState } from "react";
import { Button, Card, Input, StatusBadge } from "../components/ui";
type Project = { id: string; name?: string; repoPath?: string };
export function Projects({ projects, archived, onArchive, onOpen, onCreate }: {
  projects: Project[]; archived: string[];
  onArchive: (id: string, archive: boolean) => Promise<void>;
  onOpen: (id: string) => void; onCreate: () => void;
}) {
  const [view, setView] = useState("active");
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<Project | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const visible = projects.filter(p => archived.includes(p.id) === (view === "archived") && `${p.name} ${p.repoPath}`.toLowerCase().includes(query.toLowerCase()));
  async function change(project: Project, archive: boolean) {
    setBusy(true); setError("");
    try { await onArchive(project.id, archive); setPending(null); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="project-manager">
    <div className="project-toolbar">
      <div className="settings-nav" aria-label="Project views">
        <Button aria-pressed={view === "active"} onClick={() => setView("active")}>Active projects</Button>
        <Button aria-pressed={view === "archived"} onClick={() => setView("archived")}>Archived projects</Button>
      </div>
      <Button onClick={onCreate}>New project</Button>
    </div>
    <Input aria-label="Search projects" placeholder="Search by name or repository path" value={query} onChange={e => setQuery(e.target.value)} />
    <p className="muted">Archiving hides a project from your active Heimdall views. It preserves files and history and does not stop running work. Restore it here at any time.</p>
    {error && <p role="alert">{error}</p>}
    {pending && <Card className="panel archive-confirm">
      <h2>Archive {pending.name ?? pending.id}?</h2>
      <p>The source project remains in Mimir and Sindri. Only its visibility in Heimdall changes.</p>
      <div className="actions"><Button disabled={busy} onClick={() => void change(pending, true)}>Confirm archive</Button><Button disabled={busy} onClick={() => setPending(null)}>Keep active</Button></div>
    </Card>}
    <div className="project-grid">
      {visible.map(p => <Card className="panel project-card" key={p.id}>
        <div className="section-title"><h2>{p.name ?? "Local project"}</h2><StatusBadge value={view === "active" ? "active" : "archived"} /></div>
        <p className="id">{p.repoPath ?? p.id}</p>
        <div className="actions">
          {view === "active" ? <><Button onClick={() => onOpen(p.id)}>Open project</Button><Button disabled={busy} onClick={() => setPending(p)}>Archive</Button></> : <Button disabled={busy} onClick={() => void change(p, false)}>Restore project</Button>}
        </div>
      </Card>)}
    </div>
    {!visible.length && <Card className="panel empty">{query ? "No projects match your search." : view === "archived" ? "No archived projects." : "No active projects. Register a local repository to begin, or restore an archived project."}</Card>}
  </div>;
}
