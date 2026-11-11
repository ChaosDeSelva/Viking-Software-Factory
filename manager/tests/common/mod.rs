//! Stand-ins for launchctl, curl, open and the agent CLIs. Each test gets its own state directory;
//! nothing reaches launchd, the network or a real agent tool.
#![allow(dead_code)]
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Output},
};
use viking_manager::{write_json, Manifest, Package};
use zip::{write::SimpleFileOptions, ZipWriter};

const LAUNCHCTL: &str = r#"#!/bin/sh
s="$STUB_STATE"; echo "launchctl $*" >> "$s/calls.log"
case "$1" in
 print) [ -f "$s/${2##*/}.loaded" ] ;;
 bootstrap)
  [ -f "$s/fail-bootstrap" ] && { echo "bootstrap refused" >&2; exit 5; }
  label=$(sed -n 's/.*<key>Label<\/key><string>\([^<]*\)<.*/\1/p' "$3"); service=$(basename "$3" .plist)
  cp "$3" "$s/$service.plist.seen"; touch "$s/$label.loaded"
  if [ -f "$s/listen-$service" ]; then
   node "$STUB_BIN/listen.mjs" $(cat "$s/listen-$service") >/dev/null 2>&1 &
   echo $! > "$s/$label.pid"
   until [ -f "$s/listening-$!" ]; do sleep 0.05; done
  fi ;;
 bootout)
  label="${2##*/}"; [ -f "$s/$label.pid" ] && kill "$(cat "$s/$label.pid")"
  rm -f "$s/$label.loaded" "$s/$label.pid" ;;
esac
"#;
const LISTEN: &str = r#"import net from 'node:net';import {writeFileSync} from 'node:fs';
const ports=process.argv.slice(2).map(Number);let open=0;
for(const port of ports)net.createServer(s=>s.destroy()).listen(port,'127.0.0.1',()=>{if(++open===ports.length)writeFileSync(process.env.STUB_STATE+'/listening-'+process.pid,'');});
"#;
const CURL: &str = r#"#!/bin/sh
s="$STUB_STATE"; echo "curl $*" >> "$s/calls.log"
out=""; header=""; url=""
while [ $# -gt 0 ]; do
 case "$1" in
  --output) out="$2"; shift;; --header) header="$2"; shift;;
  -H|--max-time|--proto|--proto-redir|--max-filesize) shift;;
  -*) ;; *) url="$1";;
 esac; shift
done
case "$url" in
 */v1/health) [ -f "$s/health-ok" ] && printf '{"status":"ok"}' || exit 22 ;;
 */v1/missions) cat "${header#@}" > "$s/last-header"; [ -f "$s/missions.json" ] && cat "$s/missions.json" || { echo "refused" >&2; exit 7; } ;;
 https://api.github.com/repos/ChaosDeSelva/*)
  repo=${url#https://api.github.com/repos/ChaosDeSelva/}; repo=${repo%%/*}
  [ -f "$s/github/$repo.json" ] && cat "$s/github/$repo.json" || { echo "rate limited" >&2; exit 22; } ;;
 https://github.com/*) name=${url##*/}; [ -f "$s/assets/$name" ] && cp "$s/assets/$name" "$out" || exit 22 ;;
 http://127.0.0.1:*/) [ -f "$s/worker-ok" ] && printf '<html>' || exit 7 ;;
 *) exit 6 ;;
esac
"#;
const OPEN: &str = "#!/bin/sh\necho \"open $*\" >> \"$STUB_STATE/calls.log\"\n[ ! -f \"$STUB_STATE/open-fails\" ]\n";

pub struct Stub {
    pub dir: tempfile::TempDir,
}
impl Stub {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        for d in ["bin", "state", "state/github", "state/assets"] {
            fs::create_dir_all(dir.path().join(d)).unwrap();
        }
        for (name, body) in [
            ("launchctl", LAUNCHCTL),
            ("curl", CURL),
            ("open", OPEN),
            ("listen.mjs", LISTEN),
        ] {
            let p = dir.path().join("bin").join(name);
            fs::write(&p, body).unwrap();
            fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        }
        Self { dir }
    }
    pub fn bin(&self) -> PathBuf {
        self.dir.path().join("bin")
    }
    pub fn state(&self) -> PathBuf {
        self.dir.path().join("state")
    }
    pub fn path_var(&self) -> String {
        format!(
            "{}:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin",
            self.bin().display()
        )
    }
    pub fn flag(&self, name: &str, on: bool) {
        let p = self.state().join(name);
        if on {
            fs::write(p, "").unwrap();
        } else {
            let _ = fs::remove_file(p);
        }
    }
    pub fn write(&self, name: &str, body: &str) {
        fs::write(self.state().join(name), body).unwrap();
    }
    pub fn calls(&self) -> String {
        fs::read_to_string(self.state().join("calls.log")).unwrap_or_default()
    }
    /// Runs the CLI with this stub first on PATH.
    pub fn viking(&self, home: &Path, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_viking"))
            .args(args)
            .env_clear()
            .env("HOME", self.dir.path())
            .env("VIKING_HOME", home)
            .env("PATH", self.path_var())
            .env("STUB_STATE", self.state())
            .env("STUB_BIN", self.bin())
            .output()
            .unwrap()
    }
}
impl Drop for Stub {
    fn drop(&mut self) {
        // Stop any listener a stubbed bootstrap left running.
        if let Ok(entries) = fs::read_dir(self.state()) {
            for e in entries.flatten() {
                if e.path().extension().is_some_and(|x| x == "pid") {
                    if let Ok(pid) = fs::read_to_string(e.path()) {
                        let _ = Command::new("kill").arg(pid.trim()).status();
                    }
                }
            }
        }
    }
}

/// A runtime file set that passes preflight: `node` is a shell script that answers like Node 26.
pub const RUNTIME: [&str; 5] = [
    "node",
    "outputs/local-factory/factory.mjs",
    "work/ecosystem/mimir/apps/server/dist/start.js",
    "work/ecosystem/sindri/apps/server/dist/boot.js",
    "outputs/heimdall/apps/server/main.mjs",
];
pub fn zip_files(path: &Path, files: &[(&str, &[u8], u32)]) -> String {
    let mut z = ZipWriter::new(fs::File::create(path).unwrap());
    for (name, body, mode) in files {
        z.start_file(*name, SimpleFileOptions::default().unix_permissions(*mode))
            .unwrap();
        z.write_all(body).unwrap();
    }
    z.finish().unwrap();
    format!("{:x}", Sha256::digest(fs::read(path).unwrap()))
}
pub fn core_files(node: &'static [u8]) -> Vec<(&'static str, &'static [u8], u32)> {
    RUNTIME
        .iter()
        .map(|n| (*n, if *n == "node" { node } else { &b"// test"[..] }, 0o755))
        .collect()
}
/// Files of one archive: name, contents and Unix mode.
pub type Files<'a> = Vec<(&'a str, &'a [u8], u32)>;
pub const NODE_26: &[u8] = b"#!/bin/sh\nprintf '26\\n'\n";
/// Writes `<version>.json` and its archives into `base`; `extra` adds optional packages.
pub fn bundle_with(base: &Path, version: &str, extra: &[(&str, Files)]) -> PathBuf {
    let core = base.join(format!("core-{version}.zip"));
    let mut packages = vec![Package {
        id: "core".into(),
        version: version.into(),
        archive: format!("core-{version}.zip"),
        sha256: zip_files(&core, &core_files(NODE_26)),
        required: true,
    }];
    for (id, files) in extra {
        let name = format!("{id}-{version}.zip");
        packages.push(Package {
            id: (*id).into(),
            version: version.into(),
            archive: name.clone(),
            sha256: zip_files(&base.join(&name), files),
            required: false,
        });
    }
    let m = Manifest {
        schema: 1,
        version: version.into(),
        channel: "preview".into(),
        platform: "macos-arm64".into(),
        data_schema: 1,
        packages,
    };
    let path = base.join(format!("{version}.json"));
    write_json(&path, &m).unwrap();
    path
}
pub fn free_ports() -> [u16; 4] {
    let listeners: Vec<_> = (0..4)
        .map(|_| std::net::TcpListener::bind("127.0.0.1:0").unwrap())
        .collect();
    let ports: Vec<u16> = listeners
        .iter()
        .map(|l| l.local_addr().unwrap().port())
        .collect();
    [ports[0], ports[1], ports[2], ports[3]]
}
pub fn stdout_json(o: &Output) -> serde_json::Value {
    assert!(
        o.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&o.stderr)
    );
    serde_json::from_slice(&o.stdout).unwrap()
}
pub fn error_of(o: &Output) -> String {
    assert_eq!(
        o.status.code(),
        Some(1),
        "stdout: {}",
        String::from_utf8_lossy(&o.stdout)
    );
    let v: serde_json::Value = serde_json::from_slice(&o.stderr).unwrap();
    v["error"].as_str().unwrap().to_string()
}
/// The launchd label the manager derives for a service of the installation at `root`.
pub fn label(root: &Path, service: &str) -> String {
    let canonical = fs::canonicalize(root).unwrap();
    let hash = format!(
        "{:x}",
        Sha256::digest(canonical.to_string_lossy().as_bytes())
    );
    format!("dev.viking.factory.{}.{}", &hash[..12], service)
}
/// Opens a managed root through the CLI and points it at free ports.
pub fn managed(stub: &Stub, base: &Path) -> (PathBuf, [u16; 4]) {
    let home = base.join("managed");
    stdout_json(&stub.viking(&home, &["status"]));
    let ports = free_ports();
    let args: Vec<String> = ports.iter().map(|p| p.to_string()).collect();
    stdout_json(&stub.viking(
        &home,
        &["config", "ports", &args[0], &args[1], &args[2], &args[3]],
    ));
    (fs::canonicalize(home).unwrap(), ports)
}
