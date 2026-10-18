import type { ShellWord } from "./shell.js";

/** Where relative paths resolve. `cwd` is relative to the worktree root; `null` = unknown. */
export interface PathContext {
  /** Absolute path of the worktree root, when known. */
  worktree: string | undefined;
  cwd: string[] | null;
}

export type PathLocation =
  { kind: "special" } | { kind: "inside"; rel: string[] } | { kind: "outside" };

/**
 * Fold a path for comparison with sensitive names (E2/N1): NFKC (fullwidth forms, `ſ` to `s`,
 * ligatures), full case folding (`ß` to `ss`, Kelvin sign to `k`, dotless/dotted i to `i`), and
 * default-ignorable code points removed. This over-approximates what APFS treats as the same
 * name, which is the safe direction: more paths count as sensitive, never fewer.
 */
export function foldPath(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .toUpperCase()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .normalize("NFKC");
}

/** Device paths that are always fine to read or write. */
const SPECIAL = new Set([
  "-",
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
  "/dev/fd/1",
  "/dev/fd/2",
]);

function normalize(segments: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const s of segments) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(s);
  }
  return out;
}

export function locate(text: string, ctx: PathContext): PathLocation {
  if (SPECIAL.has(text)) return { kind: "special" };
  if (text.startsWith("~")) return { kind: "outside" };
  if (text.startsWith("/")) {
    // Case-insensitive: the target platform (APFS) folds case by default.
    const wt = ctx.worktree === undefined ? undefined : foldPath(ctx.worktree.replace(/\/+$/, ""));
    const lower = foldPath(text);
    if (wt && (lower === wt || lower.startsWith(`${wt}/`))) {
      const rel = normalize(lower.slice(wt.length).split("/"));
      return rel ? { kind: "inside", rel } : { kind: "outside" };
    }
    return { kind: "outside" };
  }
  if (ctx.cwd === null) return { kind: "outside" };
  const rel = normalize([...ctx.cwd, ...text.split("/")]);
  return rel ? { kind: "inside", rel } : { kind: "outside" };
}

/** Files and directories whose contents make tools run code or change credentials. */
const CONFIG_BASENAMES = new Set([
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".profile",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".envrc",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnpmfile.cjs",
  ".curlrc",
  ".wgetrc",
  ".netrc",
  ".gitconfig",
  ".gitmodules",
  ".git-credentials",
  ".pypirc",
  ".inputrc",
  ".lesskey",
  ".ripgreprc",
  "package.json",
  "bunfig.toml",
  "conftest.py",
  // N2: tsc and editors take output paths and plugins from these.
  "jsconfig.json",
]);
const CONFIG_PATTERNS = [
  /^(?:vitest|vite|eslint|prettier|jest|babel|webpack|rollup|tsup|playwright|svelte|next|nuxt|astro)\.config\.[cm]?[jt]sx?$/,
  /^\.(?:eslintrc|prettierrc|babelrc|mocharc)(?:\..*)?$/,
  // N2: `outDir`, `declarationDir`, `tsBuildInfoFile` and `-p` targets come from these.
  /^tsconfig(?:\..*)?\.json$/,
];
const CONFIG_DIRS = [".git", ".husky", ".claude", ".github", ".vscode", ".idea", ".devcontainer"];

/** True when writing `rel` (relative to the worktree) could make a later command run code. */
export function isSensitiveRel(relIn: readonly string[]): boolean {
  // Compare folded: on a case-folding filesystem `.GIT`, `.huſky` and `.ßh` name `.git`,
  // `.husky` and `.ssh`.
  const rel = relIn.map(foldPath);
  if (rel.some((s) => s === ".git")) return true;
  if (rel.some((s) => CONFIG_DIRS.includes(s))) return true;
  if (rel.includes("node_modules") && rel.includes(".bin")) return true;
  const base = rel[rel.length - 1];
  if (base === undefined) return false;
  return CONFIG_BASENAMES.has(base) || CONFIG_PATTERNS.some((re) => re.test(base));
}

/** `ok` when writing `w` stays inside the worktree and away from `.git` and config/exec files. */
export function writeAllowed(w: ShellWord, ctx: PathContext): boolean {
  if (w.unresolved) return false;
  const loc = locate(w.text, ctx);
  if (loc.kind === "special") return true;
  if (loc.kind === "outside") return false;
  return !isSensitiveRel(loc.rel);
}

/** Deleting/moving away `w`: inside is fine, `.git`/config is unclassifiable, outside is flagged. */
export function deleteVerdict(w: ShellWord, ctx: PathContext): "ok" | "outside" | "unclassified" {
  if (w.unresolved) return "unclassified";
  const loc = locate(w.text, ctx);
  if (loc.kind === "special") return "ok";
  if (loc.kind === "outside") return "outside";
  if (loc.rel.length === 0) return "unclassified"; // the worktree root itself
  return isSensitiveRel(loc.rel) ? "unclassified" : "ok";
}

/** A directory argument (`git -C`, `cd`, `pnpm -C`) that must stay inside the worktree. */
export function dirInside(w: ShellWord, ctx: PathContext): string[] | null {
  if (w.unresolved) return null;
  const loc = locate(w.text, ctx);
  return loc.kind === "inside" ? loc.rel : null;
}

/** A home directory: `~`, `/Users/<u>`, `/home/<u>`, `/root` or `/var/root`. */
const HOME = String.raw`(?:^~|^/users/[^/]+|^/home/[^/]+|^/root|^/var/root)`;
const home = (rest: string) => new RegExp(`${HOME}/${rest}`);

/**
 * Credential locations shared with the security audit (M2) and the Msec lane's list
 * (`~/.mimir/**`, `~/.claude/**`, `~/.config/herdr/**`, `~/.ssh/**`, `~/.aws/**`, `~/.netrc`,
 * `.env*`). Until `packages/core/src/sensitive-paths.ts` lands on main this list lives here;
 * the merge point is to import that constant and delete the duplicate entries below.
 */
export const SENSITIVE_HOME_PATHS: readonly RegExp[] = [
  // Mimir's data dir (token, database); worktrees under it are ordinary files.
  home(String.raw`\.mimir(?:/(?!worktrees(?:/|$))|$)`),
  home(String.raw`\.claude(?:/|$)`),
  home(String.raw`\.claude\.json$`),
  home(String.raw`\.config/herdr(?:/|$)`),
  home(String.raw`\.config/anthropic(?:/|$)`),
  home(String.raw`\.codex/auth\.json$`),
  home(String.raw`\.azure(?:/|$)`),
  home(String.raw`\.aws(?:/|$)`),
  home(String.raw`library/keychains(?:/|$)`),
];

const SECRET_PATTERNS: readonly RegExp[] = [
  ...SENSITIVE_HOME_PATHS,
  /^\/proc\/[^/]+\/environ$/,
  /(?:^|\/)\.ssh(?:\/|$)/,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/,
  /\.(?:pem|key|p12|pfx|jks|keystore)$/i,
  // `.env*`, as in the shared list (`.env`, `.env.local`, `.envrc`, `.env.example`).
  /(?:^|\/)\.env[^/]*$/,
  /(?:^|\/)\.aws\/(?:credentials|config)$/,
  /(?:^|\/)\.netrc$/,
  /(?:^|\/)\.git-credentials$/,
  /^~\/\.npmrc$/,
  /^~\/\.pypirc$/,
  /(?:^|\/)\.docker\/config\.json$/,
  /(?:^|\/)\.kube\/config$/,
  /(?:^|\/)\.config\/gh\/hosts\.yml$/,
  /(?:^|\/)\.gnupg(?:\/|$)/,
  /(?:^|\/)\.password-store(?:\/|$)/,
  /^\/etc\/(?:shadow|sudoers)$/,
  /(?:^|\/)\.config\/gcloud\/.*credentials/,
  /(?:^|\/)\.cargo\/credentials(?:\.toml)?$/,
  /(?:^|\/)\.terraform\.d\/credentials/,
  /(?:^|\/)\.(?:bash|zsh|sh|python|node_repl|psql|mysql)_history$/,
  /(?:^|\/)\.histfile$/,
];

/** True when `text` (a path, `@path`, or `--opt=path`) names a credential or key file. */
export function isSecretPath(text: string): boolean {
  text = foldPath(text); // patterns are lower-case; filesystems fold case (E2/N1)
  const candidates = new Set([text]);
  if (text.startsWith("@")) candidates.add(text.slice(1));
  const eq = text.lastIndexOf("=");
  if (eq >= 0) candidates.add(text.slice(eq + 1).replace(/^[@<]/, "")); // `-F k=@f`, `k=<f`
  const at = text.indexOf("@");
  if (at > 0) candidates.add(text.slice(at + 1)); // `--data-urlencode name@file`
  const colon = text.lastIndexOf(":");
  if (colon >= 0) candidates.add(text.slice(colon + 1)); // `git show REV:path`, `scp host:path`
  if (text.startsWith("file://")) candidates.add(text.slice("file://".length));
  for (const c of [...candidates]) candidates.add(lexical(c));
  for (const c of candidates) {
    const t = c.replace(/\/+$/, "");
    if (SECRET_PATTERNS.some((re) => re.test(t))) return true;
  }
  return false;
}

/** Resolve `.` and `..` segments lexically (`~/.mimir/worktrees/../auth-token`). */
function lexical(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === ".") continue;
    if (
      seg === ".." &&
      out.length > 0 &&
      out[out.length - 1] !== "" &&
      out[out.length - 1] !== ".."
    ) {
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

/** Names that hold credentials when read (on top of SECRET_PATTERNS), compared folded. */
const SENSITIVE_READ_BASENAMES = new Set([
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  ".pgpass",
  ".my.cnf",
  ".htpasswd",
  "credentials",
  "credentials.json",
]);

/**
 * Exact-allowlist path check for `cat`/`head`/`ls` and project entries: the path must resolve
 * inside the worktree (with a known cwd), outside `.git`, and must not be a credential path or
 * basename, all compared after folding.
 */
export function readAllowed(text: string, ctx: PathContext): boolean {
  if (isSecretPath(text)) return false;
  const loc = locate(text, ctx);
  if (loc.kind !== "inside") return false;
  const rel = loc.rel.map(foldPath);
  if (rel.includes(".git")) return false;
  const base = rel[rel.length - 1];
  return base === undefined || !SENSITIVE_READ_BASENAMES.has(base);
}
