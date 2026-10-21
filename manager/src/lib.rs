use base64::Engine;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::os::unix::fs::PermissionsExt;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, Write},
    net::{SocketAddr, TcpStream},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const REPO: &str = "ChaosDeSelva/Viking-Software-Factory";
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|x| x.as_secs())
        .unwrap_or(0)
}
pub fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("pending");
    let mut f = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&tmp)?;
    f.set_permissions(fs::Permissions::from_mode(0o600))?;
    f.write_all(bytes)?;
    f.sync_all()?;
    fs::rename(tmp, path)?;
    Ok(())
}
pub fn write_json<T: Serialize>(p: &Path, v: &T) -> Result<()> {
    atomic(p, &serde_json::to_vec_pretty(v)?)
}
pub fn read_json<T: serde::de::DeserializeOwned>(p: &Path) -> Result<T> {
    Ok(serde_json::from_slice(&fs::read(p)?)?)
}
fn safe_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() < 100
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-+".contains(&c))
        && s != "."
        && s != ".."
}
fn relative(s: &str) -> Result<PathBuf> {
    let p = Path::new(s);
    if s.is_empty() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("Unsafe relative path".into());
    }
    Ok(p.to_owned())
}
fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
fn run(c: &mut Command) -> Result<String> {
    run_bounded(c, Duration::from_secs(30))
}
fn run_bounded(c: &mut Command, timeout: Duration) -> Result<String> {
    let mut stdout = tempfile::tempfile()?;
    let mut stderr = tempfile::tempfile()?;
    let mut child = c
        .stdout(stdout.try_clone()?)
        .stderr(stderr.try_clone()?)
        .stdin(Stdio::null())
        .spawn()?;
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() > timeout {
            child.kill()?;
            child.wait()?;
            return Err("Command timed out".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    stdout.rewind()?;
    stderr.rewind()?;
    let mut output = String::new();
    stdout.take(8 * 1024 * 1024).read_to_string(&mut output)?;
    if !status.success() {
        let mut error = String::new();
        stderr.take(8192).read_to_string(&mut error)?;
        return Err(format!("Command failed: {error}").into());
    }
    Ok(output)
}
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Package {
    pub id: String,
    pub version: String,
    pub archive: String,
    pub sha256: String,
    #[serde(default)]
    pub required: bool,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Manifest {
    pub schema: u32,
    pub version: String,
    pub channel: String,
    pub platform: String,
    pub data_schema: u32,
    pub packages: Vec<Package>,
}
impl Manifest {
    pub fn validate(&self) -> Result<()> {
        if self.schema != 1 || self.data_schema != 1 {
            return Err("Unsupported manifest or data schema. A migration must be implemented before updating.".into());
        }
        semver::Version::parse(&self.version)?;
        if self.platform != "macos-arm64" || !["stable", "preview"].contains(&self.channel.as_str())
        {
            return Err("Unsupported platform or channel".into());
        }
        let mut names = BTreeSet::new();
        for p in &self.packages {
            if !["core", "skidbladnir", "hulder", "bifrost", "companion"].contains(&p.id.as_str())
                || !names.insert(&p.id)
                || !safe_name(&p.archive)
                || !p.archive.ends_with(".zip")
                || p.sha256.len() != 64
                || !p.sha256.bytes().all(|c| c.is_ascii_hexdigit())
            {
                return Err("Invalid package manifest".into());
            }
            semver::Version::parse(&p.version)?;
        }
        if !self.packages.iter().any(|p| p.id == "core" && p.required) {
            return Err("Required core package missing".into());
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Receipt {
    pub version: String,
    pub data_schema: u32,
    pub components: Vec<String>,
    pub installed_at: u64,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Config {
    pub channel: String,
    pub update_key: Option<String>,
    pub path: String,
    pub mimir_port: u16,
    pub sindri_port: u16,
    pub heimdall_port: u16,
    pub skidbladnir_port: u16,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            channel: "preview".into(),
            update_key: option_env!("VIKING_UPDATE_PUBLIC_KEY").map(String::from),
            path: std::env::var("PATH")
                .unwrap_or_else(|_| "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin".into()),
            mimir_port: 7700,
            sindri_port: 4310,
            heimdall_port: 4320,
            skidbladnir_port: 4380,
        }
    }
}
pub struct Manager {
    pub root: PathBuf,
    _lock: File,
}
impl Manager {
    pub fn open(root: PathBuf) -> Result<Self> {
        if root.exists() && fs::symlink_metadata(&root)?.file_type().is_symlink() {
            return Err("Managed root cannot be a symlink".into());
        }
        if !root.is_absolute()
            || root.parent().is_none()
            || std::env::var_os("HOME").map(PathBuf::from).as_ref() == Some(&root)
        {
            return Err("Choose a dedicated absolute directory for managed state".into());
        }
        if root.is_dir()
            && !root.join("manager.lock").exists()
            && fs::read_dir(&root)?.next().is_some()
        {
            return Err("Managed root must be empty or an existing manager installation".into());
        }
        fs::create_dir_all(&root)?;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("manager.lock"))?;
        lock.try_lock_exclusive()
            .map_err(|_| "Another manager command is running")?;
        for p in ["releases", "downloads", "data", "logs", "backups"] {
            fs::create_dir_all(root.join(p))?;
        }
        if !root.join("config.json").exists() {
            write_json(&root.join("config.json"), &Config::default())?;
        }
        Ok(Self {
            root: fs::canonicalize(root)?,
            _lock: lock,
        })
    }
    pub fn config(&self) -> Result<Config> {
        read_json(&self.root.join("config.json"))
    }
    pub fn current(&self) -> Result<Option<Receipt>> {
        let p = self.root.join("current.json");
        if p.exists() {
            Ok(Some(read_json(&p)?))
        } else {
            Ok(None)
        }
    }
    pub fn release(&self) -> Result<PathBuf> {
        let r = self
            .current()?
            .ok_or("Nothing installed. Run install first.")?;
        if !safe_name(&r.version) {
            return Err("Invalid installation receipt".into());
        }
        Ok(self.root.join("releases").join(r.version))
    }
    pub fn label(&self, service: &str) -> String {
        let hash = format!(
            "{:x}",
            Sha256::digest(self.root.to_string_lossy().as_bytes())
        );
        format!("dev.viking.factory.{}.{}", &hash[..12], service)
    }
    fn domain(&self) -> Result<String> {
        Ok(format!("gui/{}", run(Command::new("id").arg("-u"))?.trim()))
    }
    pub fn running(&self, service: &str) -> bool {
        self.domain()
            .ok()
            .map(|d| {
                Command::new("launchctl")
                    .args(["print", &format!("{}/{}", d, self.label(service))])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    }
    fn occupied(port: u16) -> bool {
        TcpStream::connect_timeout(
            &SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_millis(250),
        )
        .is_ok()
    }
    fn idle(&self) -> Result<()> {
        let cfg = self.config()?;
        if self.running("core") {
            let token = fs::read_to_string(self.root.join("data/mimir/auth-token"))?;
            let header = self.root.join("auth-header.tmp");
            atomic(
                &header,
                format!("Authorization: Bearer {}\n", token.trim()).as_bytes(),
            )?;
            let response = run(Command::new("curl")
                .args([
                    "--fail",
                    "--silent",
                    "--show-error",
                    "--max-time",
                    "4",
                    "--header",
                ])
                .arg(format!("@{}", header.display()))
                .arg(format!("http://127.0.0.1:{}/v1/missions", cfg.mimir_port)));
            fs::remove_file(header)?;
            let v: Value = serde_json::from_str(&response?)?;
            let missions = v["missions"]
                .as_array()
                .ok_or("Cannot determine active work; refusing to stop")?;
            if missions.iter().any(|m| {
                !["completed", "failed", "cancelled", "draft"]
                    .contains(&m["status"].as_str().unwrap_or("unknown"))
            }) {
                return Err("Active or paused missions exist. Settle them in Heimdall before stopping or updating.".into());
            }
        } else if Self::occupied(cfg.mimir_port) {
            return Err(
                "Mimir port belongs to an unmanaged process; it will not be touched".into(),
            );
        }
        Ok(())
    }
    pub fn install(&self, source: &Path, selection: &[String]) -> Result<Value> {
        if self.root.join("transaction.json").exists() {
            return Err("Recover the interrupted update before installing".into());
        }
        let bytes = fs::read(source)?;
        let manifest: Manifest = serde_json::from_slice(&bytes)?;
        manifest.validate()?;
        self.idle()?;
        let current = self.current()?;
        if let Some(c) = &current {
            if manifest.data_schema != c.data_schema {
                return Err("Data migration is not supported by this release".into());
            }
        }
        let selected: Vec<_> = manifest
            .packages
            .iter()
            .filter(|p| p.required || selection.contains(&p.id))
            .collect();
        for s in selection {
            if !manifest.packages.iter().any(|p| &p.id == s) {
                return Err(format!("Component unavailable: {s}").into());
            }
        }
        let dest = self.root.join("releases").join(&manifest.version);
        if dest.exists() {
            return Err(
                "This version already exists. Use rollback or a new release version.".into(),
            );
        }
        let stage = self
            .root
            .join("releases")
            .join(format!("{}.staging", manifest.version));
        if stage.exists() {
            fs::remove_dir_all(&stage)?;
        }
        // Reserve room for expansion, a consistent data snapshot and runtime writes.
        let mut required = tree_size(&self.root.join("data"))?.saturating_add(128 * 1024 * 1024);
        for package in &selected {
            let archive = source
                .parent()
                .ok_or("Missing source parent")?
                .join(&package.archive);
            let mut zip = zip::ZipArchive::new(fs::File::open(archive)?)?;
            for i in 0..zip.len() {
                required = required.saturating_add(zip.by_index(i)?.size());
            }
        }
        if fs2::available_space(&self.root)? < required {
            return Err(format!("Not enough disk space. Need at least {} MiB free before installation. Nothing was stopped.", required / 1024 / 1024 + 1).into());
        }
        fs::create_dir(&stage)?;
        let attempt = (|| -> Result<Receipt> {
            for p in &selected {
                let archive = source
                    .parent()
                    .ok_or("Missing source parent")?
                    .join(&p.archive);
                extract_zip(&archive, &stage.join(&p.id), &p.sha256)?;
            }
            preflight(&stage)?;
            let receipt = Receipt {
                version: manifest.version.clone(),
                data_schema: manifest.data_schema,
                components: selected.iter().map(|p| p.id.clone()).collect(),
                installed_at: now(),
            };
            write_json(&stage.join("receipt.json"), &receipt)?;
            Ok(receipt)
        })();
        let receipt = match attempt {
            Ok(r) => r,
            Err(e) => {
                fs::remove_dir_all(stage)?;
                return Err(e);
            }
        };
        let was_running = self.running("core");
        let skid_running = self.running("skidbladnir");
        if was_running || skid_running {
            self.stop()?;
        }
        let backup =
            self.root
                .join("backups")
                .join(format!("before-{}-{}", manifest.version, now()));
        if current.is_some() {
            copy_tree(&self.root.join("data"), &backup)?;
        }
        fs::rename(stage, &dest)?;
        if let Some(c) = &current {
            write_json(
                &self.root.join("previous.json"),
                &json!({"receipt":c,"backup":backup}),
            )?;
        }
        // Journal precedes the pointer change, so an interrupted activation can be recovered.
        write_json(
            &self.root.join("transaction.json"),
            &json!({"previous":current,"next":receipt,"backup":backup}),
        )?;
        write_json(&self.root.join("current.json"), &receipt)?;
        if was_running {
            if let Err(e) = self.start_impl() {
                self.restore_transaction()?;
                return Err(format!("Activation failed and prior data restored: {e}").into());
            }
        }
        if skid_running {
            if let Err(e) = self.start_skidbladnir() {
                self.stop()?;
                self.restore_transaction()?;
                return Err(
                    format!("Worker service activation failed; prior data restored: {e}").into(),
                );
            }
        }
        fs::remove_file(self.root.join("transaction.json"))?;
        Ok(json!({"installed":receipt,"running":was_running}))
    }
    pub fn recover(&self) -> Result<Value> {
        if self.root.join("transaction.json").exists() {
            self.stop()?;
            self.restore_transaction()?;
            Ok(json!({"recovered":true}))
        } else {
            Ok(json!({"recovered":false}))
        }
    }
    fn restore_transaction(&self) -> Result<()> {
        let transaction: Value = read_json(&self.root.join("transaction.json"))?;
        if !transaction["previous"].is_null() {
            let receipt: Receipt = serde_json::from_value(transaction["previous"].clone())?;
            self.restore_data(Path::new(
                transaction["backup"].as_str().ok_or("Missing backup")?,
            ))?;
            write_json(&self.root.join("current.json"), &receipt)?;
        } else {
            fs::remove_file(self.root.join("current.json"))?;
        }
        fs::remove_file(self.root.join("transaction.json"))?;
        Ok(())
    }
    fn restore_data(&self, backup: &Path) -> Result<()> {
        if !backup.starts_with(self.root.join("backups")) || !backup.is_dir() {
            return Err("Invalid recovery backup".into());
        }
        let saved = self.root.join("backups").join(format!(
            "replaced-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos()
        ));
        let prepared = self.root.join("data.restore");
        if prepared.exists() {
            fs::remove_dir_all(&prepared)?;
        }
        copy_tree(backup, &prepared)?;
        if self.root.join("data").exists() {
            fs::rename(self.root.join("data"), saved)?;
        }
        fs::rename(prepared, self.root.join("data"))?;
        Ok(())
    }
    pub fn rollback(&self) -> Result<Value> {
        self.idle()?;
        let previous: Value = read_json(&self.root.join("previous.json"))?;
        let receipt: Receipt = serde_json::from_value(previous["receipt"].clone())?;
        preflight(&self.root.join("releases").join(&receipt.version))?;
        self.stop()?;
        write_json(
            &self.root.join("transaction.json"),
            &json!({"previous":receipt,"backup":previous["backup"]}),
        )?;
        self.restore_transaction()?;
        fs::remove_file(self.root.join("previous.json"))?;
        Ok(
            json!({"rolled_back":receipt,"note":"Prior data restored. Services remain stopped; run start when ready."}),
        )
    }
    fn bootstrap(
        &self,
        service: &str,
        program: &Path,
        args: &[String],
        env: BTreeMap<String, String>,
    ) -> Result<()> {
        let mut plist=format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>Label</key><string>{}</string><key>ProgramArguments</key><array><string>{}</string>",self.label(service),xml(&program.to_string_lossy()));
        for a in args {
            plist.push_str(&format!("<string>{}</string>", xml(a)));
        }
        plist.push_str("</array><key>EnvironmentVariables</key><dict>");
        for (k, v) in env {
            plist.push_str(&format!(
                "<key>{}</key><string>{}</string>",
                xml(&k),
                xml(&v)
            ));
        }
        for (k, v) in [
            ("HOME", std::env::var("HOME")?),
            (
                "PATH",
                format!(
                    "{}:{}",
                    self.release()?.join("core").display(),
                    self.config()?.path
                ),
            ),
        ] {
            plist.push_str(&format!("<key>{k}</key><string>{}</string>", xml(&v)));
        }
        plist.push_str(&format!("</dict><key>WorkingDirectory</key><string>{}</string><key>RunAtLoad</key><true/><key>ExitTimeOut</key><integer>30</integer><key>StandardOutPath</key><string>{}</string><key>StandardErrorPath</key><string>{}</string></dict></plist>",xml(&self.release()?.to_string_lossy()),xml(&self.root.join("logs").join(format!("{service}.log")).to_string_lossy()),xml(&self.root.join("logs").join(format!("{service}.log")).to_string_lossy())));
        let log = self.root.join("logs").join(format!("{service}.log"));
        if fs::metadata(&log)
            .map(|m| m.len() > 5 * 1024 * 1024)
            .unwrap_or(false)
        {
            fs::rename(&log, log.with_extension("previous.log"))?;
        }
        let file = self.root.join(format!("{service}.plist"));
        atomic(&file, plist.as_bytes())?;
        run(Command::new("launchctl")
            .arg("bootstrap")
            .arg(self.domain()?)
            .arg(file))?;
        Ok(())
    }
    pub fn start(&self) -> Result<Value> {
        if self.root.join("transaction.json").exists() {
            return Err("Interrupted update. Run recover.".into());
        }
        self.start_impl()
    }
    fn start_impl(&self) -> Result<Value> {
        let cfg = self.config()?;
        if self.running("core") {
            if self.ready(&cfg) {
                return Ok(json!({"running":true,"already_loaded":true}));
            }
            return Err(
                "The managed job is loaded but unhealthy. Inspect local logs before recovery."
                    .into(),
            );
        }
        for port in [cfg.mimir_port, cfg.sindri_port, cfg.heimdall_port] {
            if Self::occupied(port) {
                return Err(format!("Port {port} is occupied. Nothing was stopped.").into());
            }
        }
        let dir = self.release()?;
        preflight(&dir)?;
        let mut env = BTreeMap::new();
        for (k, v) in [
            (
                "FACTORY_DATA_DIR",
                self.root.join("data").display().to_string(),
            ),
            (
                "FACTORY_ACCESS_FILE",
                self.root.join("access.json").display().to_string(),
            ),
            ("FACTORY_NO_OPEN", "1".into()),
            ("FACTORY_QUIET_AUTH", "1".into()),
            ("MIMIR_PORT", cfg.mimir_port.to_string()),
            ("SINDRI_PORT", cfg.sindri_port.to_string()),
            ("HEIMDALL_PORT", cfg.heimdall_port.to_string()),
        ] {
            env.insert(k.into(), v);
        }
        self.bootstrap(
            "core",
            &dir.join("core/node"),
            &[dir
                .join("core/outputs/local-factory/factory.mjs")
                .display()
                .to_string()],
            env,
        )?;
        for _ in 0..80 {
            if self.ready(&cfg) {
                return Ok(
                    json!({"running":true,"url":format!("http://127.0.0.1:{}",cfg.heimdall_port)}),
                );
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        self.bootout("core")?;
        Err("Services did not become ready. Run doctor and inspect local logs.".into())
    }
    pub fn healthy(&self) -> bool {
        self.running("core") && self.config().map(|c| self.ready(&c)).unwrap_or(false)
    }
    fn ready(&self, cfg: &Config) -> bool {
        if ![cfg.mimir_port, cfg.sindri_port, cfg.heimdall_port]
            .iter()
            .all(|p| Self::occupied(*p))
        {
            return false;
        }
        [cfg.mimir_port, cfg.sindri_port].iter().all(|p| {
            run(Command::new("curl").args([
                "--fail",
                "--silent",
                "--max-time",
                "1",
                &format!("http://127.0.0.1:{p}/v1/health"),
            ]))
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .map(|v| v["status"] == "ok")
            .unwrap_or(false)
        })
    }
    pub fn start_skidbladnir(&self) -> Result<Value> {
        let cfg = self.config()?;
        let dir = self.release()?;
        if !dir.join("skidbladnir/apps/api/server.mjs").exists() {
            return Err("Skidbladnir is not installed".into());
        }
        if self.running("skidbladnir") {
            if self.worker_ready(cfg.skidbladnir_port) {
                return Ok(json!({"running":true}));
            }
            return Err("Managed Skidbladnir is loaded but unhealthy. Inspect local logs.".into());
        }
        if Self::occupied(cfg.skidbladnir_port) {
            return Err("Skidbladnir port is occupied".into());
        }
        let env = BTreeMap::from([
            ("PORT".into(), cfg.skidbladnir_port.to_string()),
            (
                "SKIDBLADNIR_DATA_DIR".into(),
                self.root.join("data/skidbladnir").display().to_string(),
            ),
        ]);
        self.bootstrap(
            "skidbladnir",
            &dir.join("core/node"),
            &[dir
                .join("skidbladnir/apps/api/server.mjs")
                .display()
                .to_string()],
            env,
        )?;
        for _ in 0..80 {
            if self.worker_ready(cfg.skidbladnir_port) {
                return Ok(json!({"started":true}));
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        self.bootout("skidbladnir")?;
        Err("Skidbladnir did not become ready. Inspect local logs.".into())
    }
    fn worker_ready(&self, port: u16) -> bool {
        run(Command::new("curl").args([
            "--fail",
            "--silent",
            "--max-time",
            "1",
            &format!("http://127.0.0.1:{port}/"),
        ]))
        .map(|body| body.contains("<html"))
        .unwrap_or(false)
    }
    fn bootout(&self, service: &str) -> Result<()> {
        if self.running(service) {
            run(Command::new("launchctl").args([
                "bootout",
                &format!("{}/{}", self.domain()?, self.label(service)),
            ]))?;
        }
        Ok(())
    }
    pub fn stop(&self) -> Result<Value> {
        self.idle()?;
        let cfg = self.config()?;
        let core = self.running("core");
        let skid = self.running("skidbladnir");
        self.bootout("skidbladnir")?;
        self.bootout("core")?;
        let mut ports = vec![];
        if core {
            ports.extend([cfg.mimir_port, cfg.sindri_port, cfg.heimdall_port]);
        }
        if skid {
            ports.push(cfg.skidbladnir_port);
        }
        for _ in 0..120 {
            if ports.iter().all(|p| !Self::occupied(*p)) {
                return Ok(json!({"stopped":true}));
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        Err("Managed ports did not close. Data was not replaced.".into())
    }
    pub fn status(&self) -> Result<Value> {
        let cfg = self.config()?;
        Ok(
            json!({"installation":self.current()?,"core_loaded":self.running("core"),"core_healthy":self.healthy(),"skidbladnir_loaded":self.running("skidbladnir"),"ports":{"mimir":Self::occupied(cfg.mimir_port),"sindri":Self::occupied(cfg.sindri_port),"heimdall":Self::occupied(cfg.heimdall_port)},"pending_recovery":self.root.join("transaction.json").exists(),"channel":cfg.channel,"root":self.root}),
        )
    }
    pub fn doctor(&self) -> Result<Value> {
        let cfg = self.config()?;
        let mut checks = vec![];
        for (name, args) in [
            ("git", vec!["--version"]),
            ("codex", vec!["login", "status"]),
            ("claude", vec!["auth", "status"]),
        ] {
            let executable=if name=="codex" && Path::new("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex").exists(){"/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"}else{name};
            let result = run(Command::new(executable).args(args).env("PATH", &cfg.path));
            let ok = result
                .map(|o| {
                    name != "claude"
                        || serde_json::from_str::<Value>(&o)
                            .map(|v| v["loggedIn"] == true)
                            .unwrap_or(false)
                })
                .unwrap_or(false);
            checks.push(json!({"name":name,"ok":ok,"action":match name{"codex"=>"Install Codex and run codex login","claude"=>"Install Claude Code and run claude auth login",_=>"Install Git with Apple Command Line Tools"}}));
        }
        if let Ok(dir) = self.release() {
            checks.push(json!({"name":"managed runtime","ok":preflight(&dir).is_ok(),"action":"Reinstall a verified factory release"}));
        }
        Ok(
            json!({"checks":checks,"status":self.status()?,"signing":"Public application distribution requires Developer ID signing and notarization"}),
        )
    }
    pub fn uninstall(&self) -> Result<Value> {
        self.stop()?;
        let releases = self.root.join("releases");
        fs::remove_dir_all(&releases)?;
        fs::create_dir(releases)?;
        for f in ["current.json", "previous.json", "transaction.json"] {
            let p = self.root.join(f);
            if p.exists() {
                fs::remove_file(p)?;
            }
        }
        Ok(
            json!({"uninstalled":true,"data_preserved":self.root.join("data"),"backups_preserved":self.root.join("backups")}),
        )
    }
    pub fn update_check(&self, force: bool) -> Result<Value> {
        let cache = self.root.join("updates.json");
        if !force && cache.exists() {
            let v: Value = read_json(&cache)?;
            if now().saturating_sub(v["checked_at"].as_u64().unwrap_or(0)) < 86400 {
                return Ok(v);
            }
        }
        let cfg = self.config()?;
        let mut repos = vec![];
        for repo in [
            "Viking-Software-Factory",
            "Mimir",
            "Sindri",
            "Brokkr",
            "Heimdall",
            "Skidbladnir",
            "Hulder",
            "Bifrost",
        ] {
            let url =
                format!("https://api.github.com/repos/ChaosDeSelva/{repo}/releases?per_page=100");
            let response = run(Command::new("curl").args([
                "--fail",
                "--silent",
                "--show-error",
                "--max-time",
                "15",
                "--proto",
                "=https",
                "--tlsv1.2",
                "-H",
                "Accept: application/vnd.github+json",
                &url,
            ]));
            match response {
                Ok(body) => {
                    let list: Vec<Value> = serde_json::from_str(&body)?;
                    let latest = select_release(&list, &cfg.channel);
                    repos.push(json!({"repo":repo,"release":latest}));
                }
                Err(_) => {
                    repos.push(json!({"repo":repo,"error":"GitHub unavailable or rate limited"}))
                }
            }
        }
        let candidate = repos
            .first()
            .and_then(|r| r["release"].as_object())
            .map(|r| Value::Object(r.clone()));
        let installed = self.current()?.map(|r| r.version);
        let available = candidate
            .as_ref()
            .and_then(|r| r["tag_name"].as_str())
            .and_then(|s| semver::Version::parse(s.trim_start_matches('v')).ok())
            .map(|v| {
                installed
                    .as_ref()
                    .and_then(|s| semver::Version::parse(s).ok())
                    .map(|i| v > i)
                    .unwrap_or(true)
            })
            .unwrap_or(false);
        let installable = candidate
            .as_ref()
            .and_then(|r| r["assets"].as_array())
            .map(|assets| {
                ["factory-manifest.json", "factory-manifest.sig"]
                    .iter()
                    .all(|name| assets.iter().any(|a| a["name"] == *name))
            })
            .unwrap_or(false);
        let v = json!({"checked_at":now(),"channel":cfg.channel,"available":available,"installable":installable,"candidate":candidate,"repositories":repos,"note":"Only a compatible factory bundle can be applied. Component releases are informational."});
        write_json(&cache, &v)?;
        Ok(v)
    }
    pub fn update_apply(&self) -> Result<Value> {
        let cfg = self.config()?;
        let key = cfg.update_key.ok_or(
            "No trusted update public key configured. Signed update installation is unavailable.",
        )?;
        let info = self.update_check(true)?;
        if info["available"] != true {
            return Err("No newer compatible factory release advertised".into());
        }
        let release = &info["candidate"];
        let assets = release["assets"]
            .as_array()
            .ok_or("Release has no assets")?;
        let tag = release["tag_name"].as_str().ok_or("Release missing tag")?;
        let dir = self.root.join("downloads");
        for name in ["factory-manifest.json", "factory-manifest.sig"] {
            download_asset(assets, name, &dir.join(name))?;
        }
        verify_signature(
            &fs::read(dir.join("factory-manifest.json"))?,
            &fs::read_to_string(dir.join("factory-manifest.sig"))?,
            &key,
        )?;
        let manifest: Manifest = read_json(&dir.join("factory-manifest.json"))?;
        manifest.validate()?;
        if manifest.version != tag.trim_start_matches('v')
            || (cfg.channel == "stable" && manifest.channel != "stable")
        {
            return Err("Release identity or channel does not match signed manifest".into());
        }
        let selected = self.current()?.map(|r| r.components).unwrap_or_default();
        for p in &manifest.packages {
            if p.required || selected.contains(&p.id) {
                download_asset(assets, &p.archive, &dir.join(&p.archive))?;
            }
        }
        self.install(&dir.join("factory-manifest.json"), &selected)
    }
}
pub fn select_release(list: &[Value], channel: &str) -> Option<Value> {
    list.iter()
        .filter(|r| r["draft"] == false && (channel == "preview" || r["prerelease"] == false))
        .filter_map(|r| {
            semver::Version::parse(r["tag_name"].as_str()?.trim_start_matches('v'))
                .ok()
                .map(|v| (v, r))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, r)| r.clone())
}
fn download_asset(assets: &[Value], name: &str, path: &Path) -> Result<()> {
    let asset = assets.iter().find(|a| a["name"] == name).ok_or(format!(
        "Release does not contain {name}. Source only releases cannot be installed automatically."
    ))?;
    let url = asset["browser_download_url"]
        .as_str()
        .ok_or("Invalid asset URL")?;
    if !url.starts_with(&format!("https://github.com/{REPO}/releases/download/")) {
        return Err("Unexpected release asset origin".into());
    }
    let tmp = path.with_extension("download");
    run_bounded(
        Command::new("curl")
            .args([
                "--fail",
                "--location",
                "--silent",
                "--show-error",
                "--max-time",
                "600",
                "--max-filesize",
                "4294967296",
                "--proto",
                "=https",
                "--proto-redir",
                "=https",
                "--output",
            ])
            .arg(&tmp)
            .arg(url),
        Duration::from_secs(610),
    )?;
    fs::rename(tmp, path)?;
    Ok(())
}
pub fn verify_signature(bytes: &[u8], signature: &str, key: &str) -> Result<()> {
    let b64 = base64::engine::general_purpose::STANDARD;
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, b64.decode(key.trim())?)
        .verify(bytes, &b64.decode(signature.trim())?)
        .map_err(|_| "Update manifest signature is invalid".into())
}
pub fn extract_zip(archive: &Path, dest: &Path, expected: &str) -> Result<()> {
    let mut source = File::open(archive)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = source.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    if format!("{:x}", hash.finalize()) != expected.to_lowercase() {
        return Err("Package checksum mismatch".into());
    }
    let mut zip = zip::ZipArchive::new(File::open(archive)?)?;
    let mut total = 0u64;
    if zip.len() > 150000 {
        return Err("Too many archive entries".into());
    }
    for i in 0..zip.len() {
        let f = zip.by_index(i)?;
        relative(f.name()?.trim_end_matches('/'))?;
        total = total.checked_add(f.size()).ok_or("Archive size overflow")?;
        if total > 8 * 1024 * 1024 * 1024 {
            return Err("Archive exceeds size limit".into());
        }
    }
    fs::create_dir_all(dest)?;
    let mut links = vec![];
    for i in 0..zip.len() {
        let mut f = zip.by_index(i)?;
        let path = dest.join(relative(f.name()?.trim_end_matches('/'))?);
        if f.unix_mode().unwrap_or(0) & 0o170000 == 0o120000 {
            let mut target = String::new();
            f.take(4097).read_to_string(&mut target)?;
            if target.len() > 4096 {
                return Err("Symlink target too long".into());
            }
            let mut normalized = path
                .parent()
                .ok_or("Link parent missing")?
                .strip_prefix(dest)?
                .to_path_buf();
            for part in Path::new(&target).components() {
                match part {
                    Component::Normal(v) => normalized.push(v),
                    Component::CurDir => {}
                    Component::ParentDir => {
                        if !normalized.pop() {
                            return Err("Archive link escapes installation".into());
                        }
                    }
                    _ => return Err("Absolute archive link rejected".into()),
                }
            }
            links.push((path, target));
            continue;
        }
        if f.is_dir() {
            fs::create_dir_all(path)?;
            continue;
        }
        fs::create_dir_all(path.parent().ok_or("No parent")?)?;
        let mut out = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        std::io::copy(&mut f, &mut out)?;
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(if f.unix_mode().unwrap_or(0) & 0o111 != 0 {
                0o700
            } else {
                0o600
            }),
        )?;
    }
    // Create links only after all regular writes, then resolve every chain inside the root.
    for (path, target) in &links {
        fs::create_dir_all(path.parent().ok_or("Link parent missing")?)?;
        std::os::unix::fs::symlink(target, path)?;
    }
    let canonical = fs::canonicalize(dest)?;
    for (path, _) in links {
        if !fs::canonicalize(path)?.starts_with(&canonical) {
            return Err("Archive link resolves outside installation".into());
        }
    }
    Ok(())
}
fn preflight(dir: &Path) -> Result<()> {
    for file in [
        "core/node",
        "core/outputs/local-factory/factory.mjs",
        "core/work/ecosystem/mimir/apps/server/dist/start.js",
        "core/work/ecosystem/sindri/apps/server/dist/boot.js",
        "core/outputs/heimdall/apps/server/main.mjs",
    ] {
        if !dir.join(file).is_file() {
            return Err(format!("Missing runtime file: {file}").into());
        }
    }
    let v = run(
        Command::new(dir.join("core/node")).args(["-p", "process.versions.node.split('.')[0]"])
    )?;
    if v.trim().parse::<u32>()? < 25 {
        return Err("Bundled Node is too old".into());
    }
    run(Command::new(dir.join("core/node")).current_dir(dir.join("core")).args(["--input-type=module","-e","await import('./work/ecosystem/mimir/apps/server/dist/start.js'); await import('./work/ecosystem/sindri/apps/server/dist/boot.js'); await import('./outputs/heimdall/apps/server/main.mjs');"]))?;
    Ok(())
}
fn tree_size(path: &Path) -> Result<u64> {
    let mut total: u64 = 0;
    for entry in fs::read_dir(path)? {
        let path = entry?.path();
        let metadata = fs::symlink_metadata(&path)?;
        total = total.saturating_add(if metadata.is_dir() {
            tree_size(&path)?
        } else {
            metadata.len()
        });
    }
    Ok(total)
}
fn copy_tree(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let e = entry?;
        let kind = e.file_type()?;
        if kind.is_symlink() {
            std::os::unix::fs::symlink(fs::read_link(e.path())?, dst.join(e.file_name()))?;
        } else if kind.is_dir() {
            copy_tree(&e.path(), &dst.join(e.file_name()))?;
        } else if kind.is_file() {
            fs::copy(e.path(), dst.join(e.file_name()))?;
        }
    }
    Ok(())
}
