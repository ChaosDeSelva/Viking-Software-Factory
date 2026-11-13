import { CodeBlock, Cluster, Stack } from "@factory/ui";
import { useState } from "react";
import type { SkillDetail, SkillImportResult, SkillSummary } from "../api/work-types.js";
import { digestPrefix } from "../components/WorkKind.js";
import {
  Badge,
  Button,
  Callout,
  Card,
  Empty,
  Field,
  inputClass,
  LoadState,
  Timestamp,
} from "../components/ui.js";
import { useApi, useLoad, useReportError, useStore } from "../store/context.js";

const SKIP_REASONS: Record<string, string> = {
  symlink_escapes: "a symlink points outside the folder",
  too_large: "over 64 KB",
  not_a_file: "SKILL.md is not a file",
  unreadable: "could not be read",
};

/** The machine-wide skills library: SKILL.md folders imported from disk. */
export function SkillsLibrary() {
  const api = useApi();
  const { dispatch } = useStore();
  const report = useReportError();
  const skills = useLoad(() => api.listSkills(), []);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SkillImportResult | null>(null);
  const notify = (text: string) => dispatch({ type: "notice", notice: { kind: "info", text } });
  const trimmed = path.trim();
  const reason = !trimmed
    ? "Enter a folder path first."
    : !trimmed.startsWith("/")
      ? "Use an absolute path that starts with /."
      : undefined;

  return (
    <Stack gap={4}>
      <Card
        title="Import skills"
        description="Copies a SKILL.md into the library with its sha256 digest. The file on disk is never changed."
      >
        <form
          aria-label="Import skills"
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason || busy) return;
            setBusy(true);
            api
              .importSkills(trimmed)
              .then((r) => {
                setResult(r);
                setPath("");
                notify(
                  `Imported ${r.imported.length} ${r.imported.length === 1 ? "skill" : "skills"}`,
                );
                skills.reload();
              }, report)
              .finally(() => setBusy(false));
          }}
        >
          <Field
            label="Skill folder"
            id="skill-path"
            hint="An absolute path, such as ~/.claude/skills/<name> written out in full (/Users/you/.claude/skills/<name>), or a parent folder to import every skill in it."
          >
            <input
              id="skill-path"
              aria-describedby="skill-path-hint"
              className={inputClass}
              autoComplete="off"
              spellCheck={false}
              placeholder="/Users/you/.claude/skills/code-review"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          </Field>
          <div>
            <Button
              type="submit"
              loading={busy}
              {...(!busy && reason ? { disabledReason: reason } : {})}
            >
              Import
            </Button>
          </div>
        </form>
        {result && result.skipped.length > 0 ? (
          <Callout tone="warning" title={`Skipped ${result.skipped.length}`}>
            <ul className="ml-4 list-disc text-sm [overflow-wrap:anywhere]">
              {result.skipped.map((s) => (
                <li key={s.path}>
                  <code>{s.path}</code>: {SKIP_REASONS[s.reason] ?? s.reason}
                </li>
              ))}
            </ul>
          </Callout>
        ) : null}
      </Card>
      <Card
        title="Skills library"
        {...(skills.state.status === "ready" ? { count: skills.state.data.length } : {})}
      >
        <LoadState state={skills.state} what="skills" onRetry={skills.reload}>
          {(list) =>
            list.length === 0 ? (
              <Empty body="Import a SKILL.md folder above.">No skills yet.</Empty>
            ) : (
              <ul aria-label="Skills" className="flex flex-col divide-y divide-line">
                {list.map((s) => (
                  <SkillRow key={s.id} skill={s} onChanged={skills.reload} />
                ))}
              </ul>
            )
          }
        </LoadState>
      </Card>
    </Stack>
  );
}

function SkillRow({ skill: s, onChanged }: { skill: SkillSummary; onChanged: () => void }) {
  const api = useApi();
  const { dispatch } = useStore();
  const report = useReportError();
  const [busy, setBusy] = useState<"reimport" | "delete" | "preview" | null>(null);
  const [preview, setPreview] = useState<SkillDetail | null>(null);
  const [confirming, setConfirming] = useState(false);
  const notify = (text: string) => dispatch({ type: "notice", notice: { kind: "info", text } });
  const previewId = `skill-preview-${s.id}`;

  return (
    <li className="flex min-w-0 flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <Cluster gap={2} justify="between" align="start">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium [overflow-wrap:anywhere]">{s.name}</span>
            <code className="text-xs text-muted" title={s.digest}>
              {digestPrefix(s.digest)}
            </code>
            {s.missingOnDisk ? (
              <Badge
                tone="danger"
                tooltip="The SKILL.md is gone or unreadable; the library copy is kept."
              >
                Missing on disk
              </Badge>
            ) : s.changedOnDisk ? (
              <Badge
                tone="warn"
                tooltip="The file on disk differs from the imported copy. Re-import to update."
              >
                Changed on disk
              </Badge>
            ) : null}
          </span>
          {s.description ? (
            <span className="text-sm text-muted [overflow-wrap:anywhere]">{s.description}</span>
          ) : null}
          <span className="font-mono text-xs text-muted [overflow-wrap:anywhere]">
            {s.sourcePath}
          </span>
          <span className="text-xs text-muted">
            Imported <Timestamp value={s.updatedAt} />
          </span>
        </div>
        <Cluster gap={2}>
          <Button
            size="sm"
            variant="secondary"
            aria-expanded={preview !== null}
            aria-controls={preview ? previewId : undefined}
            loading={busy === "preview"}
            onClick={() => {
              if (preview) return setPreview(null);
              setBusy("preview");
              api
                .getSkill(s.id)
                .then(setPreview, report)
                .finally(() => setBusy(null));
            }}
          >
            {preview ? "Hide" : "Preview"} <span className="sr-only">{s.name}</span>
          </Button>
          <Button
            size="sm"
            variant="secondary"
            loading={busy === "reimport"}
            disabled={busy !== null}
            onClick={() => {
              setBusy("reimport");
              api
                .reimportSkill(s.id)
                .then(() => {
                  notify(`Re-imported ${s.name}`);
                  setPreview(null);
                  onChanged();
                }, report)
                .finally(() => setBusy(null));
            }}
          >
            Re-import <span className="sr-only">{s.name}</span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            aria-expanded={confirming}
            onClick={() => setConfirming(true)}
          >
            Delete <span className="sr-only">{s.name}</span>
          </Button>
        </Cluster>
      </Cluster>
      {confirming ? (
        <Callout tone="danger" title={`Delete ${s.name}?`}>
          <p className="text-sm">
            It is removed from the library and from every project&apos;s default skills. The folder
            on disk is not touched.
          </p>
          <Cluster gap={2} className="mt-2">
            <Button
              size="sm"
              variant="danger"
              loading={busy === "delete"}
              onClick={() => {
                setBusy("delete");
                api
                  .deleteSkill(s.id)
                  .then(() => {
                    notify(`Deleted ${s.name}`);
                    setConfirming(false);
                    onChanged();
                  }, report)
                  .finally(() => setBusy(null));
              }}
            >
              Delete skill
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </Cluster>
        </Callout>
      ) : null}
      {preview ? (
        <div id={previewId}>
          <CodeBlock title={`${s.name} · SKILL.md`} code={preview.content} maxHeight="360px" />
        </div>
      ) : null}
    </li>
  );
}
