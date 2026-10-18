import { EVENT_TYPE_LIST } from "../lib/eventTypes.js";
import type { EventFilter } from "../lib/derive.js";

interface Option {
  value: string;
  label: string;
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col text-sm">
      <span className="font-medium">{label}</span>
      <select
        className="input"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Filters for crew, agent (session), task, event type and provenance. */
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
    <div className="mb-2 flex flex-wrap gap-2">
      {crews.length > 0 && (
        <FilterSelect
          label="Crew"
          value={filter.crewId ?? ""}
          options={crews}
          onChange={set("crewId")}
        />
      )}
      {sessions.length > 0 && (
        <FilterSelect
          label="Agent"
          value={filter.sessionId ?? ""}
          options={sessions}
          onChange={set("sessionId")}
        />
      )}
      {tasks.length > 0 && (
        <FilterSelect
          label="Task"
          value={filter.taskId ?? ""}
          options={tasks}
          onChange={set("taskId")}
        />
      )}
      <FilterSelect
        label="Type"
        value={filter.type ?? ""}
        options={EVENT_TYPE_LIST.map((t) => ({ value: t, label: t }))}
        onChange={set("type")}
      />
      <FilterSelect
        label="Provenance"
        value={filter.provenance ?? ""}
        options={[
          { value: "observed", label: "observed" },
          { value: "derived", label: "derived" },
          { value: "summarized", label: "summarized (AI)" },
        ]}
        onChange={set("provenance")}
      />
    </div>
  );
}
