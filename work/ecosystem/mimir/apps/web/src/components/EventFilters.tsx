import { Field, InfoHint, Select } from "@factory/ui";
import { EVENT_TYPE_LIST } from "../lib/eventTypes.js";
import type { EventFilter } from "../lib/derive.js";

interface Option {
  value: string;
  label: string;
}

/** A labelled 40px select with a fixed width, so long option text never sets the row width. */
function FilterSelect({
  label,
  value,
  options,
  onChange,
  allLabel = "All",
  width = "w-44",
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (v: string) => void;
  allLabel?: string;
  width?: string;
}) {
  return (
    <Field label={label} className={`${width} max-w-full`}>
      <Select
        value={value}
        onValueChange={onChange}
        options={[{ value: "", label: allLabel }, ...options]}
      />
    </Field>
  );
}

export function EventFilters({
  filter,
  onChange,
  crews = [],
  sessions = [],
  tasks = [],
}: {
  filter: EventFilter;
  onChange: (f: EventFilter) => void;
  crews?: Option[];
  sessions?: Option[];
  tasks?: Option[];
}) {
  const set = (key: keyof EventFilter) => (v: string) => {
    const next = { ...filter };
    if (v === "") delete next[key];
    else (next as Record<string, string>)[key] = v;
    onChange(next);
  };
  return (
    <div className="flex flex-wrap items-end gap-3">
      {crews.length > 0 && (
        <FilterSelect
          label="Crew"
          value={filter.crewId ?? ""}
          options={crews}
          onChange={set("crewId")}
          allLabel="All crews"
        />
      )}
      {sessions.length > 0 && (
        <FilterSelect
          label="Agent"
          value={filter.sessionId ?? ""}
          options={sessions}
          onChange={set("sessionId")}
          allLabel="All agents"
        />
      )}
      {tasks.length > 0 && (
        <FilterSelect
          label="Task"
          value={filter.taskId ?? ""}
          options={tasks}
          onChange={set("taskId")}
          allLabel="All tasks"
          width="w-56"
        />
      )}
      <FilterSelect
        label="Type"
        value={filter.type ?? ""}
        options={EVENT_TYPE_LIST.map((t) => ({ value: t, label: t }))}
        onChange={set("type")}
        allLabel="All types"
        width="w-52"
      />
      <div className="flex items-end gap-1">
        <FilterSelect
          label="Provenance"
          value={filter.provenance ?? ""}
          options={[
            { value: "observed", label: "observed" },
            { value: "derived", label: "derived" },
            { value: "summarized", label: "summarized (AI)" },
          ]}
          onChange={set("provenance")}
          allLabel="Any source"
        />
        <span className="mb-2.5">
          <InfoHint term="Provenance" label="What is provenance?">
            Where an event came from: observed (reported by the runtime), derived (computed by
            Mimir) or summarized (written by an AI).
          </InfoHint>
        </span>
      </div>
    </div>
  );
}
