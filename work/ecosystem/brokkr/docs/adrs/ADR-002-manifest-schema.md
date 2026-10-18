# ADR-002: Manifest schemas (`brokkr.dev/v1alpha1`)

* Status: accepted
* Date: 2026-10-14

## Decision

Manifests are YAML (or JSON by extension), validated with Zod strict objects. Unknown keys are errors, so typos fail loudly. Every issue is reported with a dotted path (`checks.0.command`) and the file it came from.

**Harness package layout**

```
<harness>/
  harness.yaml                     # kind: Harness (spec §5.2 shape)
  skills/<skill>/skill.yaml        # kind: Skill
  skills/<skill>/instructions.md   # body (any relative .md path)
```

**Rules beyond basic shape**

| Field | Rule |
|---|---|
| `metadata.name` | kebab case, max 64 characters |
| `metadata.version` | exact semver |
| `dependsOn[].version`, `compatibility.brokkr` | semver ranges |
| `checks[].command` | argv array of non empty strings, never a shell string; check ids are unique |
| `checks[].cwd`, `when.fileExists[]`, skill `body` | relative paths that cannot escape: no absolute paths, no `..` after normalisation, no backslashes |
| skill names | a name cannot be both required and optional; a skill's name must equal its directory name |
| skill `dependsOn` | must be shipped by the same harness package, so a package is self contained and its digest covers everything it needs |
| task `id` | `[A-Za-z0-9][A-Za-z0-9._-]*`, because it becomes a directory name under `.brokkr/generated/task-context/` |

**Validation (`Registry.validate`)** continues after schema errors, so one run reports both the schema problems and any missing skill references.

**Lockfile (`.brokkr/harness.lock.json`)**

* Records exact harness versions with their tree digests and source, skill versions with digests, and adapter versions.
* `digest` is SHA-256 over canonical JSON of everything except `generatedAt`, so relocking unchanged content gives the same digest.
* The current format is `lockVersion: 2`. Version 1 allowed `excluded` lists and is rejected with a hint to run `brokkr harness lock`.

**Tree digest**

* SHA-256 over `path NUL sha256(bytes) LF` for every regular file, in sorted POSIX path order.
* Nothing is ever excluded (fix round 1, review C1; fix round 2, review N1).
  * `.DS_Store`, `.git` and `node_modules` are hashed like any other file.
  * There is no ignore mechanism: a `.brokkrignore` is an ordinary file that is hashed like any other.
  * The short lived `.brokkrignore` exclusion feature was removed. It could hide `harness.yaml` or skill bodies from both external pins and lock verification.
* Skill bodies must be regular files whose realpath is inside the skill directory. They are checked with lstat and realpath at validation time, and adapters re check before reading.
* Symlinks, FIFOs, sockets and devices fail hashing, and therefore validation. The digest always covers the bytes that will actually be read.

**Composition (`compose`)**

* Checks are deduplicated by id. The first definition in dependency order wins, and if another harness defines the same id differently a warning is emitted.
* A check that is required anywhere stays required.
* Policies take the strictest value: `deny` beats `allow`. `requireApprovalFor` is the union.
* Skills: required lists are unioned; optional is the union minus anything required.
* Workflow stages and AI review criteria are ordered unions. Evidence flags are OR ed.

**Skill selection (`resolveSkills`)**

* Scoring per selector match:

  | Match | Points |
  |---|---|
  | task type (`task.taskTypes ∪ task.tags`) | +3 |
  | word boundary keyword in title, description or tags | +2 |
  | `pathGlobs` matching one of `task.paths` (minimatch) | +2 |
  | skill tag matching a detected repository framework | +1 |

* An optional skill is selected at a score of 2 or more. Repository signals alone (+1) therefore never pull in a skill.
* Budget trimming drops optional skills lowest score first, breaking ties by dropping the alphabetically later name. It never drops required skills or their dependencies.
* The AI hook can only add names from the optional candidate list.

## Consequences

Strict schemas make forward compatibility explicit: new fields need a new `apiVersion`. Harnesses that share a skill, such as `typescript` in both built ins, must ship byte identical copies. A same version skill with different content is rejected as `skill-conflict`.
