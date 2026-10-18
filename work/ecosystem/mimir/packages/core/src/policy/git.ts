import { type Ctx, type Result, SECRET_READ, UNCLASSIFIED } from "./context.js";
import { getopt, has, opts, valueOf, type OptTable, type Parsed } from "./getopt.js";
import { deleteVerdict, writeAllowed } from "./paths.js";
import type { ShellWord } from "./shell.js";

/** `git -c key=value` / `git config key value` keys that cannot make git run another program. */
export const SAFE_GIT_CONFIG: readonly RegExp[] = [
  /^user\.(?:name|email|signingkey)$/,
  /^color\.[a-z.]+$/,
  /^advice\.[a-z]+$/,
  /^init\.defaultbranch$/,
  /^(?:commit|tag)\.gpgsign$/,
  /^core\.(?:quotepath|autocrlf|eol|filemode|ignorecase|safecrlf)$/,
  /^pull\.(?:rebase|ff)$/,
  /^push\.(?:default|autosetupremote)$/,
  /^merge\.conflictstyle$/,
  /^rebase\.(?:autosquash|autostash|updaterefs)$/,
  /^fetch\.prune$/,
  /^branch\.[^.]+\.(?:merge|rebase)$/,
  /^log\.(?:showsignature|date|decorate)$/,
  /^diff\.(?:renames|algorithm|colormoved|mnemonicprefix)$/,
  /^status\.(?:short|branch|showuntrackedfiles)$/,
  /^protocol\.version$/,
];

export function isSafeGitConfigKey(key: string): boolean {
  const k = key.toLowerCase();
  return SAFE_GIT_CONFIG.some((re) => re.test(k));
}

const MERGE_STRATEGIES = ["ort", "recursive", "resolve", "octopus", "ours", "subtree"];

const GLOBAL = opts(
  "C=,c=,git-dir=,work-tree=,namespace=,no-pager,P,p|paginate,bare,no-replace-objects," +
    "literal-pathspecs,glob-pathspecs,noglob-pathspecs,icase-pathspecs,no-optional-locks," +
    "no-advice,exec-path?!,config-env=!,super-prefix=!,list-cmds=,html-path,man-path,info-path," +
    "version,help",
  { permute: false },
);

const DIFF =
  "p|u|patch,s|no-patch,U|unified=,stat?,numstat,shortstat,name-only,name-status,summary," +
  "patch-with-stat,patch-with-raw,z,raw,minimal,patience,histogram,diff-algorithm=,color?," +
  "color-moved?,color-moved-ws=,word-diff?,word-diff-regex=,color-words?,w|ignore-all-space," +
  "b|ignore-space-change,ignore-space-at-eol,ignore-blank-lines,ignore-cr-at-eol,R,relative?," +
  "a|text,full-index,binary,abbrev?,M|find-renames*,C|find-copies*,find-copies-harder," +
  "D|irreversible-delete,l=,diff-filter=,S=,G=,pickaxe-all,pickaxe-regex,O=<,src-prefix=," +
  "dst-prefix=,no-prefix,default-prefix,line-prefix=,ita-invisible-in-index,ext-diff!," +
  "no-ext-diff,textconv!,no-textconv,ignore-submodules?,submodule?,exit-code,quiet,check,output=>,dirstat?,cumulative," +
  "compact-summary,renames,B|break-rewrites*,W|function-context,inter-hunk-context=,anchored=," +
  "indent-heuristic,merge-base";
const LOG =
  DIFF +
  ",oneline,n|max-count=,skip=,since=,after=,until=,before=,author=,committer=,grep=,all-match," +
  "invert-grep,i|regexp-ignore-case,E|extended-regexp,F|fixed-strings,P|perl-regexp,merges," +
  "min-parents=,max-parents=,first-parent,all,branches?,tags?,remotes?,exclude=,reflog," +
  "g|walk-reflogs,graph,decorate?,decorate-refs=,decorate-refs-exclude=,source,mailmap," +
  "use-mailmap,follow,L=,format=,pretty?,abbrev-commit,date=,reverse,topo-order,date-order," +
  "author-date-order,left-right,cherry-pick,cherry-mark,cherry,boundary,simplify-by-decoration," +
  "full-history,ancestry-path?,parents,children,show-signature,notes?,show-notes?,relative-date," +
  "c,cc,m,dd,remerge-diff,diff-merges=,log-size,encoding=,expand-tabs?,show-pulls,full-diff," +
  "count,objects,no-walk?,do-walk,stdin,not,1";

const t = (dsl: string, numeric = false, values?: Record<string, readonly string[]>) =>
  opts(dsl, { negatable: true, numeric, ...(values ? { values } : {}) });

const STRATEGY = { strategy: MERGE_STRATEGIES };

const MERGE_OPTS =
  "ff,ff-only,squash,commit,e|edit,m=,F|file=<,s|strategy=,X|strategy-option=,stat,n,log?," +
  "signoff,verify-signatures,allow-unrelated-histories,autostash,q|quiet,v|verbose,abort,quit," +
  "continue,S|gpg-sign*,verify,cleanup=,rerere-autoupdate,into-name=,progress";
const FETCH_OPTS =
  "all,a|append,atomic,depth=,deepen=,shallow-since=,shallow-exclude=,unshallow,update-shallow," +
  "negotiation-tip=,negotiate-only,dry-run,porcelain,write-fetch-head,f|force,k|keep,multiple," +
  "auto-maintenance,auto-gc,write-commit-graph,prefetch,p|prune,P|prune-tags,t|tags," +
  "refetch,refmap=,recurse-submodules?,j|jobs=,set-upstream,u|update-head-ok,upload-pack=!," +
  "q|quiet,v|verbose,progress,o|server-option=,show-forced-updates,4|ipv4,6|ipv6,filter=";

const TABLES: Record<string, OptTable> = {
  status: t(
    "s|short,b|branch,porcelain?,long,v|verbose,u|untracked-files*,ignored?," +
      "ignore-submodules?,z,column?,ahead-behind,renames,find-renames?,show-stash",
  ),
  log: t(LOG, true),
  show: t(LOG, true),
  whatchanged: t(LOG, true),
  shortlog: t(LOG + ",s|summary,e|email,group=,w*", true),
  "rev-list": t(LOG + ",objects-edge,left-only,right-only,missing=,timestamp,header,quiet", true),
  "range-diff": t(LOG + ",creation-factor=,dual-color,left-only,right-only", true),
  diff: t(DIFF + ",cached,staged,no-index", true),
  "diff-tree": t(DIFF + ",r,t,root,stdin,m,c,cc,v,commit-id,always,pretty?,format=,z", true),
  add: t(
    "A|all,u|update,p|patch,i|interactive,n|dry-run,v|verbose,f|force,N|intent-to-add,e|edit," +
      "refresh,ignore-errors,ignore-missing,renormalize,ignore-removal,chmod=," +
      "pathspec-from-file=<,pathspec-file-nul,sparse",
  ),
  commit: t(
    "m|message=,a|all,amend,edit,q|quiet,v|verbose,s|signoff,verify,n,F|file=<," +
      "C|reuse-message=,c|reedit-message=,fixup=,squash=,author=,date=,allow-empty," +
      "allow-empty-message,e,gpg-sign?,S*,t|template=<,cleanup=,only,o,i|include,p|patch," +
      "dry-run,short,branch,porcelain,long,z,u|untracked-files*,status,reset-author,trailer=," +
      "pathspec-from-file=<,pathspec-file-nul,post-rewrite,null",
  ),
  fetch: t(FETCH_OPTS),
  pull: t(
    FETCH_OPTS.replace(",u|update-head-ok", "") + ",r|rebase?," + MERGE_OPTS,
    false,
    STRATEGY,
  ),
  merge: t(MERGE_OPTS, false, STRATEGY),
  checkout: t(
    "b=,B=,orphan=,t|track?,f|force,q|quiet,m|merge,p|patch,detach,ours,theirs,conflict=," +
      "ignore-skip-worktree-bits,overlay,l,recurse-submodules?,progress,pathspec-from-file=<," +
      "pathspec-file-nul,guess,ignore-other-worktrees",
  ),
  switch: t(
    "c|create=,C|force-create=,d|detach,orphan=,t|track?,f|force|discard-changes,m|merge," +
      "q|quiet,guess,conflict=,recurse-submodules?,progress,ignore-other-worktrees",
  ),
  restore: t(
    "s|source=,p|patch,W|worktree,S|staged,q|quiet,progress,ours,theirs,m|merge,conflict=," +
      "ignore-unmerged,ignore-skip-worktree-bits,overlay,recurse-submodules?," +
      "pathspec-from-file=<,pathspec-file-nul",
  ),
  reset: t(
    "soft,mixed,hard,merge,keep,q|quiet,N|intent-to-add,p|patch,recurse-submodules?," +
      "pathspec-from-file=<,pathspec-file-nul,refresh",
  ),
  stash: t(
    DIFF +
      ",m|message=,p|patch,k|keep-index,u|include-untracked,a|all,q|quiet,S|staged,index," +
      "pathspec-from-file=<,pathspec-file-nul,only-untracked",
  ),
  branch: t(
    "d|delete,D,f|force,m|move,M,c|copy,C,l|list,a|all,r|remotes,v|verbose,q|quiet,t|track?," +
      "u|set-upstream-to=,unset-upstream,contains=,merged=,points-at=,sort=,format=," +
      "show-current,column?,color?,abbrev=,i|ignore-case,omit-empty,create-reflog," +
      "recurse-submodules",
  ),
  tag: t(
    "a|annotate,s|sign,u|local-user=,f|force,d|delete,v|verify,n*,l|list,sort=,m|message=," +
      "F|file=<,e|edit,contains=,merged=,points-at=,column?,format=,i|ignore-case,cleanup=," +
      "create-reflog,color?,omit-empty",
  ),
  "rev-parse": t(
    "abbrev-ref?,short?,verify,q|quiet,show-toplevel,show-prefix,show-cdup,git-dir," +
      "absolute-git-dir,git-common-dir,is-inside-work-tree,is-inside-git-dir," +
      "is-bare-repository,is-shallow-repository,symbolic,symbolic-full-name,all,branches?," +
      "tags?,remotes?,show-object-format?,sq,default=,revs-only,no-revs,flags,no-flags," +
      "local-env-vars,path-format=,git-path=,show-superproject-working-tree," +
      "shared-index-path,since=,until=,disambiguate=,prefix=,glob=,exclude=",
  ),
  "ls-files": t(
    "c|cached,d|deleted,m|modified,o|others,i|ignored,s|stage,u|unmerged,k|killed,z," +
      "x|exclude=,X|exclude-from=<,exclude-per-directory=,exclude-standard,error-unmatch," +
      "with-tree=,t,v,f,full-name,recurse-submodules,abbrev?,debug,eol,deduplicate,sparse," +
      "format=,directory,empty-directory,resolve-undo",
  ),
  "ls-tree": t(
    "d,r,t,l|long,z,name-only,name-status,object-only,full-name,full-tree,abbrev?,format=",
  ),
  blame: t(
    "L=,b,root,show-stats,l,t,S=<,reverse=,p|porcelain,line-porcelain,incremental,encoding=," +
      "contents=<,date=,M*,C*,ignore-rev=,ignore-revs-file=<,h,c,score-debug,f|show-name," +
      "n|show-number,s,e|show-email,w,abbrev=,first-parent,color-lines,color-by-age,progress",
  ),
  "merge-base": t("a|all,octopus,independent,is-ancestor,fork-point"),
  describe: t(
    "all,tags,contains,abbrev=,candidates=,exact-match,debug,long,match=,exclude=,always," +
      "first-parent,dirty?,broken?",
  ),
  "show-ref": t("head,heads,branches,tags,d|dereference,s|hash*,abbrev?,verify,q|quiet,exists"),
  "for-each-ref": t(
    "count=,sort=,format=,color?,shell,perl,python,tcl,points-at=,merged=,contains=," +
      "ignore-case,omit-empty,exclude=,include-root-refs",
  ),
  "cat-file": t(
    "t,s,e,p,textconv!,filters!,path=,batch?,batch-check?,batch-command?,batch-all-objects," +
      "buffer,unordered,follow-symlinks,allow-unknown-type,mailmap,use-mailmap,Z,z",
  ),
  reflog: t(LOG + ",expire=,expire-unreachable=,rewrite,updateref,stale-fix", true),
  rebase: t(
    "i|interactive,onto=,root,continue,abort,skip,quit,edit-todo,show-current-patch," +
      "autosquash,autostash,update-refs,keep-base,f|force-rebase,ff,fork-point," +
      "r|rebase-merges?,q|quiet,v|verbose,stat,n,verify,C=,ignore-whitespace,whitespace=," +
      "committer-date-is-author-date,ignore-date,reset-author-date,signoff,S|gpg-sign*," +
      "m|merge,s|strategy=,X|strategy-option=,empty=,keep-empty,reapply-cherry-picks," +
      "allow-empty-message,x|exec=!,reschedule-failed-exec,apply,trailer=",
    false,
    STRATEGY,
  ),
  "cherry-pick": t(
    "e|edit,n|no-commit,x,m|mainline=,s|signoff,S|gpg-sign*,ff,allow-empty,allow-empty-message," +
      "keep-redundant-commits,empty=,strategy=,X|strategy-option=,rerere-autoupdate,continue," +
      "skip,abort,quit,cleanup=,r",
    false,
    STRATEGY,
  ),
  revert: t(
    "e|edit,n|no-commit,m|mainline=,s|signoff,S|gpg-sign*,strategy=,X|strategy-option=," +
      "rerere-autoupdate,continue,skip,abort,quit,cleanup=,reference",
    false,
    STRATEGY,
  ),
  clean: t("d,f|force,i|interactive,n|dry-run,q|quiet,e|exclude=,x,X"),
  init: t(
    "q|quiet,bare,b|initial-branch=,template=!,separate-git-dir=!,shared?,object-format=," +
      "ref-format=",
  ),
  clone: t(
    "l|local,hardlinks,s|shared,reference=,reference-if-able=,dissociate,q|quiet,v|verbose," +
      "progress,n|no-checkout,bare,mirror,o|origin=,b|branch=,u|upload-pack=!,template=!," +
      "c|config=!,depth=,shallow-since=,shallow-exclude=,single-branch,tags," +
      "recurse-submodules?,shallow-submodules,j|jobs=,separate-git-dir=!,filter=,sparse," +
      "reject-shallow,also-filter-submodules,remote-submodules,bundle-uri=,server-option=," +
      "ref-format=,revision=",
  ),
  "ls-remote": t(
    "h|heads,t|tags,b|branches,refs,upload-pack=!,q|quiet,exit-code,get-url,symref,sort=," +
      "o|server-option=",
  ),
  remote: t("v|verbose,f,t=,m=,mirror?,tags,push,add,delete,all,n,dry-run"),
  grep: t(
    "cached,no-index,untracked,exclude-standard,recurse-submodules,a|text,textconv!," +
      "i|ignore-case,I,max-depth=,r|recursive,w|word-regexp,v|invert-match,h,H,full-name," +
      "E|extended-regexp,G|basic-regexp,P|perl-regexp,F|fixed-strings,n|line-number,column," +
      "l|files-with-matches|name-only,L|files-without-match,z|null,o|only-matching,c|count," +
      "color?,break,heading,p|show-function,A|after-context=,B|before-context=,C|context=," +
      "W|function-context,m|max-count=,threads=,f=<,e=,and,or,not,all-match,q|quiet," +
      "O|open-files-in-pager*!",
    true,
  ),
  archive: t(
    "format=,l|list,v|verbose,prefix=,o|output=>,add-file=<,add-virtual-file=," +
      "worktree-attributes,remote=,exec=!,mtime=,0,1,2,3,4,5,6,7,8,9",
  ),
  "format-patch": t(
    LOG +
      ",o|output-directory=>,stdout,numbered,N,start-number=,numbered-files,k|keep-subject," +
      "signoff,attach?,inline?,thread?,in-reply-to=,ignore-if-in-upstream,cover-letter," +
      "subject-prefix=,v|reroll-count=,to=,cc=,from?,add-header=,base=,suffix=,rfc?," +
      "zero-commit,progress,interdiff=,range-diff=,creation-factor=,cover-from-description=," +
      "description-file=<,force-in-body-from,signature=,signature-file=<,q|quiet",
    true,
  ),
  apply: t(
    "stat,numstat,summary,check,index,intent-to-add,3|3way,ours,theirs,union,cached," +
      "build-fake-ancestor=>,R|reverse,reject,z,p=,C=,unidiff-zero,apply,add,binary," +
      "exclude=,include=,ignore-space-change,ignore-whitespace,whitespace=,inaccurate-eof," +
      "v|verbose,q|quiet,recount,directory=,unsafe-paths!,allow-empty",
  ),
  am: t(
    "s|signoff,k|keep,keep-non-patch,keep-cr,c|scissors,quoted-cr=,m|message-id,q|quiet," +
      "u|utf8,3|3way,rerere-autoupdate,ignore-space-change,ignore-whitespace,whitespace=," +
      "directory=,exclude=,include=,reject,patch-format=,i|interactive," +
      "committer-date-is-author-date,ignore-date,skip,S|gpg-sign*,continue,r|resolved," +
      "resolvemsg=,abort,quit,retry,show-current-patch?,allow-empty,empty=,verify",
  ),
  notes: t(
    "m|message=,F|file=<,C|reuse-message=,c|reedit-message=,f|force,allow-empty,ref=," +
      "ignore-missing,stdin,n,v,s|strategy=,commit,abort,separator?,stripspace",
  ),
  "sparse-checkout": t("cone,sparse-index,stdin,skip-checks,rules-file=<"),
  gc: t("aggressive,auto,prune?,q|quiet,force,keep-largest-pack,cruft,max-cruft-size="),
  fsck: t(
    "unreachable,dangling,root,tags,cache,reflogs,full,connectivity-only,strict,verbose," +
      "lost-found,name-objects,progress",
  ),
  mv: t("f|force,k,n|dry-run,v|verbose,sparse"),
  rm: t(
    "f|force,n|dry-run,r,cached,ignore-unmatch,q|quiet,sparse,pathspec-from-file=<,pathspec-file-nul",
  ),
  "symbolic-ref": t("d|delete,q|quiet,short,recurse,m="),
  "verify-commit": t("v|verbose,raw"),
  cherry: t("v,abbrev?"),
  var: t("l"),
  help: t("a|all,g|guides,i|info,m|man,w|web,c|config,verbose"),
  version: t("build-options"),
  bisect: t("term-old=,term-new=,term-bad=,term-good=,no-checkout,first-parent"),
};

const CONFIG = t(
  "global,system,local,worktree,f|file=,blob=,get,get-all,get-regexp,get-urlmatch,replace-all," +
    "add,unset,unset-all,rename-section,remove-section,l|list,fixed-value,t|type=,bool,int," +
    "bool-or-int,path,expiry-date,z|null,name-only,includes,show-origin,show-scope,default=," +
    "e|edit!,get-color,get-colorbool,all,value=,regexp,url=,comment=,append",
);

/** Remote URLs whose transport could run a program (`ext::`, remote helpers, `ssh://-o...`). */
/**
 * A configured remote name (`origin`), not a URL or path. Fetching from arbitrary URLs or local
 * repos brings in refs whose trees later land in the worktree via merge/rebase/cherry-pick.
 */
function namedRemote(w: ShellWord): boolean {
  return !w.unresolved && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(w.text) && !w.text.includes("..");
}

/** checkout/switch that only creates or detaches at HEAD leave the working tree unchanged. */
function checkoutKeepsTree(sub: string, parsed: Parsed): boolean {
  const createKeys =
    sub === "checkout" ? ["b", "B", "orphan"] : ["create", "force-create", "orphan"];
  const creates = createKeys.some((k) => valueOf(parsed, k) !== undefined);
  if (parsed.operands.length > 0) return false;
  if (has(parsed, "patch", "merge", "ours", "theirs", "force")) return false;
  return creates || has(parsed, "detach") || parsed.opts.length === 0;
}

function badUrl(w: ShellWord): boolean {
  return (
    /^[A-Za-z][A-Za-z0-9+.-]*::/.test(w.text) || /:\/\/-/.test(w.text) || w.text.startsWith("-")
  );
}

function isProtected(branch: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => (p.endsWith("*") ? branch.startsWith(p.slice(0, -1)) : branch === p));
}

function mergeTarget(ctx: Ctx): "protected" | "unknown" | "ok" {
  let unknown = false;
  for (const b of ctx.branches) {
    if (b === undefined) unknown = true;
    else if (isProtected(b, ctx.protectedBranches)) return "protected";
  }
  return unknown ? "unknown" : "ok";
}

/** Generic checks after a successful parse: unresolved words and written paths. */
function finishParsed(parsed: Parsed, ctx: Ctx): Result {
  for (const o of parsed.opts) {
    if (o.def.write && o.values.some((v) => !writeAllowed(v, ctx))) return UNCLASSIFIED;
    if (o.values.some((v) => v.unresolved)) return UNCLASSIFIED;
  }
  if (parsed.operands.some((w) => w.unresolved)) return UNCLASSIFIED;
  return null;
}

export function classifyGit(args: readonly ShellWord[], ctx: Ctx): Result {
  const global = getopt(GLOBAL, args);
  if (!global.ok) return UNCLASSIFIED;
  // E5: anything that changes which repository git opens (`-C`, `--git-dir`, `--work-tree`, or
  // running anywhere but the worktree root, where an agent-written bare repo could be found)
  // lets repo config run code. Only the specific actions survive.
  let foreignRepo = ctx.cwd === null || ctx.cwd.length > 0;
  for (const o of global.opts) {
    const v = o.values[0];
    // N3: `--bare` makes the worktree root itself the git dir (agent-written `config`).
    if (["C", "git-dir", "work-tree", "bare"].includes(o.def.key)) {
      foreignRepo = true;
    }
    if (o.def.key === "c") {
      if (!v || v.unresolved || !isSafeGitConfigKey(v.text.split("=")[0] as string)) {
        return UNCLASSIFIED;
      }
    }
  }
  const [subWord, ...rest] = global.operands;
  if (!subWord) return null;
  if (subWord.unresolved) return UNCLASSIFIED;
  const sub = subWord.text;
  if (foreignRepo) {
    if (sub === "push" || sub === "send-pack" || sub === "http-push") return "git.push";
    if (sub === "credential") return SECRET_READ;
    if (sub === "merge") return "git.merge_protected";
    return UNCLASSIFIED;
  }

  switch (sub) {
    case "push":
    case "send-pack":
    case "http-push":
      return "git.push";
    case "credential":
      return SECRET_READ;
    case "merge":
      return classifyMerge(rest, ctx);
    case "pull":
      return classifyPull(rest, ctx);
    case "rebase":
    case "cherry-pick":
    case "revert":
      return classifyReplay(sub, rest, ctx);
    case "update-ref":
      return classifyUpdateRef(rest, ctx);
    case "remote":
      return classifyRemote(rest, ctx);
    case "config":
      return classifyConfig(rest);
    case "worktree":
      return classifyWorktree(rest, ctx);
    case "clone":
    case "am":
    case "restore":
      // E4: these write file contents (including symlinks and modes) the classifier cannot see.
      return UNCLASSIFIED;
    case "submodule":
      return rest[0]?.text === "status" || rest[0]?.text === "summary" ? null : UNCLASSIFIED;
    case "bisect":
      // N5: every bisect step except `log` checks out another commit's tree.
      return rest[0]?.text === "log" && rest.length === 1 ? null : UNCLASSIFIED;
    default:
      break;
  }

  const table = TABLES[sub];
  if (!table) return UNCLASSIFIED;
  const parsed = getopt(table, rest);
  if (!parsed.ok) return UNCLASSIFIED;

  if (sub === "branch") {
    if (has(parsed, "delete", "D")) return "git.delete_branch";
    if (branchMovesProtected(parsed, ctx)) return "git.merge_protected";
  }
  if (sub === "checkout" || sub === "switch") {
    if (createsProtected(sub, parsed, ctx)) return "git.merge_protected";
    trackCheckout(sub, parsed, ctx);
    if (!checkoutKeepsTree(sub, parsed)) return UNCLASSIFIED;
  }
  if (sub === "apply") {
    // Only inspection forms; applying writes unseen contents (symlinks, modes, any path).
    const inspect = ["check", "stat", "numstat", "summary"];
    const writes = [
      "index",
      "cached",
      "3way",
      "apply",
      "intent-to-add",
      "reject",
      "build-fake-ancestor",
    ];
    if (!has(parsed, ...inspect) || has(parsed, ...writes)) return UNCLASSIFIED;
  }
  if (sub === "reset" && has(parsed, "hard", "merge", "keep")) return UNCLASSIFIED;
  if (sub === "stash" && ["pop", "apply", "branch"].includes(parsed.operands[0]?.text ?? "")) {
    return UNCLASSIFIED;
  }
  if (sub === "fetch" || sub === "ls-remote") {
    if (sub === "fetch" && refspecIntoProtected(parsed.operands.slice(1), ctx)) {
      return "git.merge_protected";
    }
    if (sub === "ls-remote" && has(parsed, "get-url")) return SECRET_READ;
    if (has(parsed, "multiple", "all") && parsed.operands.length > 0) return UNCLASSIFIED;
    const repo = parsed.operands[0];
    if (repo && !namedRemote(repo)) return UNCLASSIFIED;
  }
  if (sub === "archive" && has(parsed, "remote")) {
    const r = valueOf(parsed, "remote");
    if (!r || badUrl(r)) return UNCLASSIFIED;
  }
  if (sub === "clone" && parsed.operands.length >= 2) {
    if (!writeAllowed(parsed.operands[parsed.operands.length - 1] as ShellWord, ctx)) {
      return UNCLASSIFIED;
    }
  }
  if (sub === "init" && parsed.operands[0] && !writeAllowed(parsed.operands[0], ctx)) {
    return UNCLASSIFIED;
  }
  if (sub === "mv" && parsed.operands.length >= 2) {
    if (!writeAllowed(parsed.operands[parsed.operands.length - 1] as ShellWord, ctx)) {
      return UNCLASSIFIED;
    }
    if (parsed.operands.slice(0, -1).some((w) => deleteVerdict(w, ctx) !== "ok")) {
      return UNCLASSIFIED;
    }
  }
  // Minor 2: `git rm` of `.git`/config paths is as sensitive as `rm`.
  if (sub === "rm" && parsed.operands.some((w) => deleteVerdict(w, ctx) !== "ok")) {
    return UNCLASSIFIED;
  }
  return finishParsed(parsed, ctx);
}

/**
 * N5: merge writes another ref's tree (symlinks, hooks paths, configs) into the worktree, so it
 * needs approval even into an unprotected branch; only `--abort`/`--quit` are benign.
 */
function classifyMerge(rest: readonly ShellWord[], ctx: Ctx): Result {
  const parsed = getopt(TABLES.merge as OptTable, rest);
  if (parsed.ok && onlyStops(parsed)) return null;
  const target = mergeTarget(ctx);
  if (target !== "ok") return "git.merge_protected";
  return UNCLASSIFIED;
}

function classifyPull(rest: readonly ShellWord[], ctx: Ctx): Result {
  const target = mergeTarget(ctx);
  if (target === "protected") return "git.merge_protected";
  const parsed = getopt(TABLES.pull as OptTable, rest);
  if (parsed.ok && refspecIntoProtected(parsed.operands.slice(1), ctx)) {
    return "git.merge_protected";
  }
  return UNCLASSIFIED; // N5: pulls merge fetched trees
}

/** `--abort` / `--quit` alone: stop a sequence and restore (or keep) the pre-command state. */
function onlyStops(parsed: Parsed): boolean {
  return has(parsed, "abort", "quit") && parsed.operands.length === 0 && parsed.opts.length === 1;
}

/** N5: rebase / cherry-pick / revert rewrite the current branch from other commits' trees. */
function classifyReplay(sub: string, rest: readonly ShellWord[], ctx: Ctx): Result {
  const parsed = getopt(TABLES[sub] as OptTable, rest);
  if (parsed.ok && onlyStops(parsed)) return null;
  if (mergeTarget(ctx) === "protected") return "git.merge_protected";
  return UNCLASSIFIED;
}

const UPDATE_REF = t("d,m=,no-deref,z,stdin,create-reflog");

/** N6: `update-ref` moves any ref; a protected branch is a protected-branch action. */
function classifyUpdateRef(rest: readonly ShellWord[], ctx: Ctx): Result {
  const parsed = getopt(UPDATE_REF, rest);
  if (!parsed.ok) return UNCLASSIFIED;
  const ref = parsed.operands[0];
  if (ref && !ref.unresolved && protectedRef(ref.text, ctx)) return "git.merge_protected";
  return UNCLASSIFIED;
}

/** `main`, `refs/heads/main`, `heads/main` naming a protected branch. */
function protectedRef(ref: string, ctx: Ctx): boolean {
  const name = ref
    .replace(/^\+/, "")
    .replace(/^refs\//, "")
    .replace(/^heads\//, "");
  return isProtected(name, ctx.protectedBranches);
}

/** N6: a fetch/pull refspec `[+]src:dst` whose destination is a protected branch. */
function refspecIntoProtected(specs: readonly ShellWord[], ctx: Ctx): boolean {
  return specs.some((w) => {
    if (w.unresolved) return false;
    const colon = w.text.indexOf(":");
    return colon >= 0 && protectedRef(w.text.slice(colon + 1), ctx);
  });
}

const BRANCH_LISTING = [
  "list",
  "all",
  "remotes",
  "verbose",
  "contains",
  "merged",
  "points-at",
  "show-current",
  "format",
  "sort",
];

/** N6: `branch -f/-m/-M/-c/-C` or creation naming a protected branch. */
function branchMovesProtected(parsed: Parsed, ctx: Ctx): boolean {
  const names = parsed.operands.filter((w) => !w.unresolved).map((w) => w.text);
  if (has(parsed, "force", "move", "M", "copy", "C")) {
    // force: `branch -f <name> [<start>]`; move/copy: `branch -m [<old>] <new>`.
    const targets =
      has(parsed, "force") && !has(parsed, "move", "M", "copy", "C")
        ? names.slice(0, 1)
        : names.slice(-1);
    return targets.some((n) => protectedRef(n, ctx));
  }
  if (has(parsed, ...BRANCH_LISTING) || has(parsed, "set-upstream-to", "unset-upstream")) {
    return false;
  }
  return names[0] !== undefined && protectedRef(names[0], ctx);
}

/** N6: `checkout -b/-B/--orphan` or `switch -c/-C/--orphan` naming a protected branch. */
function createsProtected(sub: string, parsed: Parsed, ctx: Ctx): boolean {
  const keys = sub === "checkout" ? ["b", "B", "orphan"] : ["create", "force-create", "orphan"];
  return keys.some((k) => {
    const v = valueOf(parsed, k);
    return v !== undefined && !v.unresolved && protectedRef(v.text, ctx);
  });
}

/** N7: `remote -v`, `get-url` and `show` print remote URLs, which may embed credentials. */
function classifyRemote(rest: readonly ShellWord[], ctx: Ctx): Result {
  const parsed = getopt(TABLES.remote as OptTable, rest);
  if (!parsed.ok) return UNCLASSIFIED;
  const verb = parsed.operands[0]?.text;
  if (has(parsed, "verbose") || verb === "get-url" || verb === "show") return SECRET_READ;
  if (verb && !["prune", "remove", "rm"].includes(verb)) return UNCLASSIFIED;
  return finishParsed(parsed, ctx);
}

const CONFIG_READ_OPTS = [
  "get",
  "get-all",
  "get-regexp",
  "get-urlmatch",
  "list",
  "get-color",
  "get-colorbool",
];
const CONFIG_WRITE_OPTS = [
  "replace-all",
  "add",
  "unset",
  "unset-all",
  "rename-section",
  "remove-section",
  "file",
  "blob",
];

/** Config keys whose values are, or may embed, credentials (N7). */
const SECRET_CONFIG_KEY =
  /extraheader|token|passw(?:or)?d|secret|credential|auth|cookie|\.url$|pushurl|insteadof|proxy|sslkey|sslcert/i;

/**
 * `git config`: listing and pattern reads print every value (CI tokens in `http.extraheader`,
 * credentials in remote URLs), so they are secret reads (N7), as are reads of credential keys.
 * Other reads are fine; writes only to keys on SAFE_GIT_CONFIG in the repository config.
 */
function classifyConfig(rest: readonly ShellWord[]): Result {
  const parsed = getopt(CONFIG, rest);
  if (!parsed.ok) return UNCLASSIFIED;
  if (parsed.opts.some((o) => o.values.some((v) => v.unresolved))) return UNCLASSIFIED;
  if (parsed.operands.some((w) => w.unresolved)) return UNCLASSIFIED;
  let ops = parsed.operands.map((w) => w.text);
  const verb = ops[0];
  if (has(parsed, "list", "get-regexp", "get-urlmatch", "regexp", "url") || verb === "list") {
    return SECRET_READ;
  }
  if (has(parsed, ...CONFIG_WRITE_OPTS)) return UNCLASSIFIED;
  const readKey = (key: string | undefined): Result =>
    key !== undefined && SECRET_CONFIG_KEY.test(key) ? SECRET_READ : null;
  if (verb === "get") return readKey(ops[1]);
  if (verb === "set") ops = ops.slice(1);
  else if (["unset", "rename-section", "remove-section", "edit"].includes(verb ?? "")) {
    return UNCLASSIFIED;
  }
  if (has(parsed, ...CONFIG_READ_OPTS)) return readKey(ops[0]);
  if (ops.length === 0) return UNCLASSIFIED;
  if (ops.length === 1 && verb !== "set") return readKey(ops[0]); // `git config key` reads
  // Minor 3: writes go to the repository config only, never `~/.gitconfig` or system config.
  if (has(parsed, "global", "system")) return UNCLASSIFIED;
  return isSafeGitConfigKey(ops[0] as string) ? null : UNCLASSIFIED;
}

const WORKTREE_REMOVE = t("f|force");
const WORKTREE_READ = t("porcelain,z,v|verbose,expire=,n|dry-run,reason=");

function classifyWorktree(rest: readonly ShellWord[], ctx: Ctx): Result {
  const verb = rest[0]?.text;
  if (verb === "remove") {
    const parsed = getopt(WORKTREE_REMOVE, rest.slice(1));
    if (!parsed.ok) return UNCLASSIFIED;
    if (has(parsed, "force")) return "git.force_remove_worktree";
    // Minor 1: like `rm`, removing a worktree outside this one is flagged.
    for (const w of parsed.operands) {
      const v = deleteVerdict(w, ctx);
      if (v === "outside") return "fs.delete_outside_worktree";
      if (v === "unclassified") return UNCLASSIFIED;
    }
    return finishParsed(parsed, ctx);
  }
  if (
    verb === "list" ||
    verb === "prune" ||
    verb === "lock" ||
    verb === "unlock" ||
    verb === "repair"
  ) {
    const parsed = getopt(WORKTREE_READ, rest.slice(1));
    return parsed.ok ? finishParsed(parsed, ctx) : UNCLASSIFIED;
  }
  // add/move: Mimir owns worktrees (ADR-002).
  return UNCLASSIFIED;
}

function trackCheckout(sub: string, parsed: Parsed, ctx: Ctx): void {
  const createKeys =
    sub === "checkout" ? ["b", "B", "orphan"] : ["create", "force-create", "orphan"];
  for (const k of createKeys) {
    const v = valueOf(parsed, k);
    if (v) {
      ctx.branches.add(v.unresolved ? undefined : v.text);
      return;
    }
  }
  if (has(parsed, "detach")) {
    ctx.branches.add(undefined);
    return;
  }
  if (parsed.dashDashAt >= 0 && parsed.dashDashAt <= 1 && sub === "checkout") {
    // `git checkout [<tree>] -- <paths>` restores files; the branch is unchanged.
    return;
  }
  const target = parsed.operands[0];
  if (!target) return;
  if (sub === "checkout" && parsed.operands.length > 1) return; // tree + paths
  ctx.branches.add(target.unresolved || target.text === "-" ? undefined : target.text);
}
