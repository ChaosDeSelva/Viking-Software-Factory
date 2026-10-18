import { type Ctx, type Result, EXTERNAL_WRITE, UNCLASSIFIED } from "./context.js";
import { getopt, opts, type OptTable, type Parsed } from "./getopt.js";
import { writeAllowed } from "./paths.js";
import type { ShellWord } from "./shell.js";

/**
 * Option roles, by option key. Options not listed under a role are allowed and inert. Options
 * not in the table at all make the command unclassifiable.
 */
interface HttpRoles {
  method: readonly string[];
  body: readonly string[];
  get: readonly string[];
  head: readonly string[];
  url: readonly string[];
  /** Send the request somewhere other than the URL host. */
  reroute: readonly string[];
  /** Options whose value is always a local file sent with the request. */
  fileBody: readonly string[];
  /** Options whose value names a file to send when it starts with `@` (or has `k@`/`=@`/`=<`). */
  fileRef: readonly string[];
}

const CURL = opts(
  "X|request=,d|data=,data-raw=,data-binary=,data-urlencode=,data-ascii=,json=,F|form=," +
    "form-string=,T|upload-file=,G|get,I|head,url=," +
    "x|proxy=,preproxy=,resolve=,connect-to=,socks4=,socks4a=,socks5=,socks5-hostname=," +
    "H|header=,A|user-agent=,e|referer=,b|cookie=,u|user=,U|proxy-user=,m|max-time=," +
    "connect-timeout=,retry=,retry-delay=,retry-max-time=,retry-all-errors,w|write-out=," +
    "r|range=,C|continue-at=,noproxy=,cacert=,capath=,E|cert=,key=,cert-type=,key-type=," +
    "Y|speed-limit=,y|speed-time=,limit-rate=,max-filesize=,max-redirs=,z|time-cond=," +
    "oauth2-bearer=,interface=,local-port=,dns-servers=,user-agent=,compressed," +
    "o|output=>,D|dump-header=>,c|cookie-jar=>,trace=>,trace-ascii=>,output-dir=>,stderr=>," +
    "etag-save=>,etag-compare=<,libcurl=!,K|config=!,next!,variable=!,parallel-max=," +
    "s|silent,S|show-error,L|location,f|fail,fail-with-body,i|include,v|verbose,k|insecure," +
    "O|remote-name,J|remote-header-name,remote-name-all,N|no-buffer,q|disable,#|progress-bar," +
    "http1.0,http1.1,http2,http2-prior-knowledge,http3,4|ipv4,6|ipv6,g|globoff,n|netrc," +
    "netrc-optional,l|list-only,location-trusted,no-progress-meter,Z|parallel,create-dirs," +
    "raw,tr-encoding,ssl-reqd,tlsv1.2,tlsv1.3,digest,basic,ntlm,negotiate,anyauth,a|append," +
    "B|use-ascii,j|junk-session-cookies,p|proxytunnel,R|remote-time,fail-early,show-headers",
);
const CURL_ROLES: HttpRoles = {
  method: ["request"],
  body: [
    "data",
    "data-raw",
    "data-binary",
    "data-urlencode",
    "data-ascii",
    "json",
    "form",
    "form-string",
    "upload-file",
  ],
  get: ["get"],
  head: ["head"],
  url: ["url"],
  reroute: ["resolve", "connect-to", "socks4", "socks4a", "socks5", "socks5-hostname"],
  fileBody: ["upload-file"],
  fileRef: [
    "data",
    "data-binary",
    "data-urlencode",
    "data-ascii",
    "json",
    "form",
    "header",
    "cookie",
  ],
};

const WGET = opts(
  "method=,post-data=,post-file=<,body-data=,body-file=<," +
    "O|output-document=>,o|output-file=>,a|append-output=>,P|directory-prefix=>," +
    "U|user-agent=,header=,t|tries=,T|timeout=,w|wait=,Q|quota=,l|level=,D|domains=,user=," +
    "password=,i|input-file=<,B|base=,referer=,max-redirect=,limit-rate=,bind-address=," +
    "ca-certificate=,certificate=,private-key=,http-user=,http-password=,save-cookies=>," +
    "load-cookies=<,e|execute=!,config=!,q|quiet,v|verbose,c|continue,N|timestamping," +
    "r|recursive,k|convert-links,p|page-requisites,m|mirror,S|server-response,spider," +
    "no-check-certificate,content-disposition,x|force-directories,4|inet4-only," +
    "6|inet6-only,no-proxy,show-progress,progress=,d|debug,no-cache,no-cookies," +
    "keep-session-cookies,ignore-length,retry-connrefused,https-only,h|help,V|version," +
    "no-verbose,no-clobber,no-parent,no-directories,no-host-directories,n=",
  { values: { n: ["v", "c", "d", "H", "p"] } },
);
const WGET_ROLES: HttpRoles = {
  method: ["method"],
  body: ["post-data", "post-file", "body-data", "body-file"],
  get: [],
  head: [],
  url: [],
  reroute: [],
  fileBody: ["post-file", "body-file"],
  fileRef: [],
};

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** curl's `--expand-<option>` (8.3+) is `<option>` with variable expansion. */
function unexpand(words: readonly ShellWord[]): ShellWord[] {
  return words.map((w) =>
    w.text.startsWith("--expand-") ? { ...w, text: `--${w.text.slice("--expand-".length)}` } : w,
  );
}

function classifyHttp(
  table: OptTable,
  roles: HttpRoles,
  words: readonly ShellWord[],
  ctx: Ctx,
): Result {
  const parsed = getopt(table, words);
  if (!parsed.ok) return UNCLASSIFIED;
  const implicit = implicitWrites(table, parsed);
  let method: ShellWord | undefined;
  let body = false;
  let get = false;
  let reroute = false;
  let fileData = false;
  let proxy: ShellWord | undefined;
  const targets: ShellWord[] = [...parsed.operands];
  for (const o of parsed.opts) {
    const k = o.def.key;
    const v = o.values[0];
    if (o.def.write && v && !writeAllowed(v, ctx)) return UNCLASSIFIED;
    if (roles.method.includes(k)) method = v;
    if (roles.body.includes(k)) body = true;
    if (roles.get.includes(k)) get = true;
    if (roles.head.includes(k)) method = { text: "HEAD", unresolved: false };
    if (roles.url.includes(k) && v) targets.push(v);
    if (roles.reroute.includes(k)) reroute = true;
    if (roles.fileBody.includes(k)) fileData = true;
    if (roles.fileRef.includes(k) && v && sendsFile(k, v)) fileData = true;
    if (k === "proxy" || k === "preproxy") proxy = v;
  }
  let writes: boolean;
  if (method) writes = method.unresolved || !READ_METHODS.has(method.text.toUpperCase());
  else writes = body && !get;
  // Audit H2: file contents leave the machine whatever the method (`-G -d @f`, `-I -d @f`,
  // `-H @f`, `-b cookiefile`, `--data-urlencode k@f`, `wget --method=GET --body-file=f`).
  if (fileData) writes = true;
  if (writes) {
    const external =
      reroute ||
      (proxy !== undefined && !isLoopback(proxy.text)) ||
      targets.length === 0 ||
      targets.some((t) => t.unresolved || !isLoopback(t.text));
    if (external) return EXTERNAL_WRITE;
  }
  if (implicit) return UNCLASSIFIED;
  if (table === CURL && globbedOutput(parsed, targets)) return UNCLASSIFIED;
  return finish(
    parsed.operands,
    parsed.opts.flatMap((o) => o.values),
  );
}

function finish(operands: readonly ShellWord[], values: readonly ShellWord[]): Result {
  return operands.some((w) => w.unresolved) || values.some((w) => w.unresolved)
    ? UNCLASSIFIED
    : null;
}

const CURL_IMPLICIT = ["remote-name", "remote-header-name", "remote-name-all", "output-dir"];
const WGET_IMPLICIT = [
  "force-directories",
  "timestamping",
  "recursive",
  "mirror",
  "page-requisites",
  "directory-prefix",
  "content-disposition",
];

/**
 * Writes whose file name the classifier cannot check (E7/E8): curl `-O`/`-J`/`--remote-name-all`
 * /`--output-dir` and `-w` with `%output{...}` or `@file`; wget without an explicit `-O`, or with
 * options that derive names or directories from the server (`-x`, `-nH`, `-N`, `-r`, `-P`, ...).
 */
function implicitWrites(table: OptTable, parsed: Parsed): boolean {
  const keys = parsed.opts.map((o) => o.def.key);
  if (table === CURL) {
    if (keys.some((k) => CURL_IMPLICIT.includes(k))) return true;
    return parsed.opts.some(
      (o) =>
        o.def.key === "write-out" &&
        o.values.some((v) => v.unresolved || v.text.includes("%output{") || v.text.startsWith("@")),
    );
  }
  if (keys.some((k) => WGET_IMPLICIT.includes(k))) return true;
  if (
    parsed.opts.some(
      (o) => o.def.key === "n" && o.values.some((v) => v.text !== "v" && v.text !== "c"),
    )
  ) {
    return true;
  }
  return !keys.includes("output-document") && !keys.includes("spider");
}

/** Does option `key` with value `v` read a local file (or stdin) into the request? */
function sendsFile(key: string, v: ShellWord): boolean {
  if (v.unresolved) return true;
  const t = v.text;
  if (t.startsWith("@")) return true; // -d @f, -H @f, --json @f, @- (stdin)
  if (key === "data-urlencode") return /^[^=]*@/.test(t); // name@file
  if (key === "form") return /=[@<]/.test(t); // k=@file, k=<file
  if (key === "cookie") return !t.includes("="); // -b file reads a cookie jar
  return false;
}

/**
 * N4: with URL globbing on (no `-g`/`--globoff`), `-o '#1'` is replaced by the matched glob
 * text, so the written name comes from the URL. Unclassified when an output name has `#<digit>`,
 * or when a globbed URL is combined with any output option.
 */
function globbedOutput(parsed: Parsed, targets: readonly ShellWord[]): boolean {
  if (parsed.opts.some((o) => o.def.key === "globoff")) return false;
  const outputs = parsed.opts.filter((o) => ["output", "output-dir"].includes(o.def.key));
  if (outputs.some((o) => o.values.some((v) => /#\d/.test(v.text)))) return true;
  return outputs.length > 0 && targets.some((t) => /[{}[\]]/.test(t.text));
}

export function classifyCurl(args: readonly ShellWord[], ctx: Ctx): Result {
  return classifyHttp(CURL, CURL_ROLES, unexpand(args), ctx);
}

export function classifyWget(args: readonly ShellWord[], ctx: Ctx): Result {
  return classifyHttp(WGET, WGET_ROLES, args, ctx);
}

export function isLoopback(target: string): boolean {
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `http://${target}`).hostname;
  } catch {
    return false;
  }
  host = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "0.0.0.0" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}
