//! The `viking` command line against stubbed launchctl, curl and open (see tests/common).
mod common;
use common::*;
use serde_json::{json, Value};
use std::{fs, os::unix::fs::PermissionsExt, process::Command};
use viking_manager::{read_json, write_json};

fn ok(stub: &Stub, home: &std::path::Path, args: &[&str]) -> Value {
    stdout_json(&stub.viking(home, args))
}
fn err(stub: &Stub, home: &std::path::Path, args: &[&str]) -> String {
    error_of(&stub.viking(home, args))
}
fn install(stub: &Stub, home: &std::path::Path, base: &std::path::Path, version: &str) -> Value {
    let manifest = bundle_with(base, version, &[]);
    ok(stub, home, &["install", manifest.to_str().unwrap()])
}
fn listen_core(stub: &Stub, ports: [u16; 4]) {
    stub.write(
        "listen-core",
        &format!("{} {} {}", ports[0], ports[1], ports[2]),
    );
    stub.flag("health-ok", true);
}

#[test]
fn help_and_argument_errors_exit_with_failure() {
    let stub = Stub::new();
    let t = tempfile::tempdir().unwrap();
    let fresh = t.path().join("fresh");
    let help = ok(&stub, &fresh, &["help", "--json"]);
    let listed: Vec<&str> = help["commands"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c.as_str().unwrap().split(' ').next().unwrap())
        .collect();
    for command in [
        "access",
        "status",
        "doctor",
        "install",
        "start",
        "stop",
        "logs",
        "update",
        "channel",
        "rollback",
        "recover",
        "uninstall",
        "open",
        "diagnostics",
        "config",
    ] {
        assert!(listed.contains(&command), "help omits {command}");
    }
    assert_eq!(ok(&stub, &fresh, &[])["commands"], help["commands"]);
    assert_eq!(ok(&stub, &fresh, &["--help"])["commands"], help["commands"]);
    assert!(!fresh.exists(), "help opens no managed root");
    let (home, _) = managed(&stub, t.path());
    for (args, message) in [
        (vec!["status", "--home"], "--home needs a directory"),
        (vec!["explode"], "Unknown command"),
        (vec!["install"], "Provide a local manifest file"),
        (vec!["update"], "Use update check or update apply"),
        (vec!["update", "later"], "Use update check or update apply"),
        (vec!["channel"], "Choose stable or preview"),
        (vec!["channel", "nightly"], "Choose stable or preview"),
        (vec!["config"], "Use config path or config ports"),
        (vec!["config", "path"], "Provide PATH"),
        (
            vec!["config", "ports", "50001", "50002"],
            "Provide four ports",
        ),
        (
            vec!["config", "ports", "50001", "50002", "50003", "80"],
            "four distinct unprivileged ports",
        ),
        (
            vec!["config", "ports", "50001", "50002", "50003", "50003"],
            "four distinct unprivileged ports",
        ),
        (vec!["uninstall"], "uninstall --confirm"),
        (vec!["logs", "secrets"], "Unknown service"),
        (vec!["diagnostics"], "Provide output path"),
        (vec!["open"], "Choose heimdall, hulder, companion or data"),
        (vec!["access"], "Factory is not healthy"),
        (vec!["rollback"], "No such file"),
        (vec!["start"], "Nothing installed"),
        (vec!["start", "skidbladnir"], "Nothing installed"),
        (vec!["open", "hulder"], "Nothing installed"),
        (vec!["logs"], "No such file"),
    ] {
        assert!(err(&stub, &home, &args).contains(message), "{args:?}");
    }
    assert!(err(&stub, &home, &["config", "ports", "1", "2", "3", "x"]).contains("invalid digit"));
}

#[test]
fn the_root_comes_from_home_flag_then_viking_home_then_home() {
    let stub = Stub::new();
    let t = tempfile::tempdir().unwrap();
    let run = |envs: &[(&str, &std::path::Path)], args: &[&str]| {
        let mut c = Command::new(env!("CARGO_BIN_EXE_viking"));
        c.args(args)
            .env_clear()
            .env("PATH", stub.path_var())
            .env("STUB_STATE", stub.state());
        for (k, v) in envs {
            c.env(k, v);
        }
        c.output().unwrap()
    };
    // Neither HOME nor VIKING_HOME is needed when --home is given.
    let flag = t.path().join("flag");
    let s = stdout_json(&run(&[], &["--home", flag.to_str().unwrap(), "status"]));
    assert_eq!(s["root"], json!(fs::canonicalize(&flag).unwrap()));
    let viking = t.path().join("viking-home");
    let s = stdout_json(&run(&[("VIKING_HOME", &viking)], &["status"]));
    assert_eq!(s["root"], json!(fs::canonicalize(&viking).unwrap()));
    let user = t.path().join("user");
    fs::create_dir(&user).unwrap();
    let s = stdout_json(&run(&[("HOME", &user)], &["status"]));
    assert_eq!(
        s["root"],
        json!(fs::canonicalize(&user)
            .unwrap()
            .join("Library/Application Support/Viking Factory"))
    );
    assert!(error_of(&run(&[], &["status"])).contains("Set HOME, VIKING_HOME or --home"));
    // Unsafe roots are refused before anything is created.
    assert!(
        error_of(&run(&[("HOME", &user)], &["--home", "relative", "status"]))
            .contains("dedicated absolute")
    );
    assert!(
        error_of(&run(&[("HOME", &user)], &["--home", "/", "status"]))
            .contains("dedicated absolute")
    );
    assert!(error_of(&run(
        &[("HOME", &user)],
        &["--home", user.to_str().unwrap(), "status"]
    ))
    .contains("dedicated absolute"));
    let link = t.path().join("link");
    std::os::unix::fs::symlink(&viking, &link).unwrap();
    assert!(error_of(&run(&[], &["--home", link.to_str().unwrap(), "status"])).contains("symlink"));
}

#[test]
fn channel_config_logs_diagnostics_and_open() {
    let stub = Stub::new();
    let t = tempfile::tempdir().unwrap();
    let (home, ports) = managed(&stub, t.path());
    fs::write(home.join("updates.json"), "{}").unwrap();
    assert_eq!(
        ok(&stub, &home, &["channel", "stable"]),
        json!({"channel":"stable"})
    );
    assert!(
        !home.join("updates.json").exists(),
        "a channel change drops the cached check"
    );
    ok(&stub, &home, &["channel", "preview"]);
    ok(&stub, &home, &["config", "path", "/custom/bin:/usr/bin"]);
    let cfg: Value = read_json(&home.join("config.json")).unwrap();
    assert_eq!(cfg["path"], "/custom/bin:/usr/bin");
    assert_eq!(cfg["channel"], "preview");
    assert_eq!(cfg["skidbladnir_port"], ports[3]);
    // Configuration is refused while a managed service is loaded.
    stub.flag(&format!("{}.loaded", label(&home, "skidbladnir")), true);
    assert!(err(&stub, &home, &["config", "path", "/x"]).contains("Stop managed services"));
    stub.flag(&format!("{}.loaded", label(&home, "skidbladnir")), false);
    stub.flag(&format!("{}.loaded", label(&home, "core")), true);
    assert!(err(&stub, &home, &["config", "path", "/x"]).contains("Stop managed services"));
    stub.flag(&format!("{}.loaded", label(&home, "core")), false);

    let lines: Vec<String> = (1..=200).map(|i| format!("line {i}")).collect();
    fs::write(home.join("logs/skidbladnir.log"), lines.join("\n")).unwrap();
    let log = ok(&stub, &home, &["logs", "skidbladnir"]);
    let shown: Vec<&str> = log["local_log"].as_str().unwrap().lines().collect();
    assert_eq!(
        (shown.len(), shown[0], shown[149]),
        (150, "line 51", "line 200")
    );
    fs::write(home.join("logs/core.log"), "core line").unwrap();
    assert_eq!(ok(&stub, &home, &["logs"])["local_log"], "core line");

    let report = t.path().join("report.json");
    assert_eq!(
        ok(&stub, &home, &["diagnostics", report.to_str().unwrap()])["exported"],
        json!(report)
    );
    let written: Value = read_json(&report).unwrap();
    let keys: Vec<&String> = written.as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        [
            "channel",
            "core_loaded",
            "installation",
            "manager_version",
            "note",
            "pending_recovery",
            "ports"
        ]
    );
    assert!(
        !fs::read_to_string(&report)
            .unwrap()
            .contains(home.to_str().unwrap()),
        "no paths are exported"
    );

    install(&stub, &home, t.path(), "0.2.0");
    ok(&stub, &home, &["open", "heimdall"]);
    ok(&stub, &home, &["open", "data"]);
    ok(&stub, &home, &["open", "hulder"]);
    ok(&stub, &home, &["open", "companion"]);
    let calls = stub.calls();
    assert!(calls.contains(&format!("open http://127.0.0.1:{}\n", ports[2])));
    assert!(calls.contains(&format!("open {}\n", home.join("data").display())));
    assert!(calls.contains(&format!(
        "open {}\n",
        home.join("releases/0.2.0/hulder/Hulder.app").display()
    )));
    assert!(calls.contains(&format!(
        "open -n {}\n",
        home.join("releases/0.2.0/companion/Viking Factory.app")
            .display()
    )));
    stub.flag("open-fails", true);
    assert!(err(&stub, &home, &["open", "data"]).contains("Could not open target"));
}

#[test]
fn services_start_report_and_stop_through_launchd_with_escaped_plists() {
    let stub = Stub::new();
    let t = tempfile::tempdir().unwrap();
    let (home, ports) = managed(&stub, t.path());
    ok(&stub, &home, &["config", "path", "/opt/<odd>&\"bin\""]);
    install(&stub, &home, t.path(), "0.2.0");
    listen_core(&stub, ports);
    // A log over 5 MiB is set aside when the job is bootstrapped again.
    fs::write(home.join("logs/core.log"), vec![b'x'; 5 * 1024 * 1024 + 1]).unwrap();
    let started = ok(&stub, &home, &["start"]);
    assert_eq!(
        fs::metadata(home.join("logs/core.previous.log"))
            .unwrap()
            .len(),
        5 * 1024 * 1024 + 1
    );
    assert!(!home.join("logs/core.log").exists());
    assert_eq!(
        started,
        json!({"running":true,"url":format!("http://127.0.0.1:{}",ports[2])})
    );
    let plist = fs::read_to_string(stub.state().join("core.plist.seen")).unwrap();
    assert!(plist.contains(&format!(
        "<key>Label</key><string>{}</string>",
        label(&home, "core")
    )));
    assert!(plist.contains("/opt/&lt;odd&gt;&amp;&quot;bin&quot;"));
    for key in [
        "FACTORY_DATA_DIR",
        "FACTORY_ACCESS_FILE",
        "FACTORY_NO_OPEN",
        "FACTORY_QUIET_AUTH",
        "MIMIR_PORT",
        "SINDRI_PORT",
        "HEIMDALL_PORT",
        "HOME",
        "PATH",
    ] {
        assert!(plist.contains(&format!("<key>{key}</key>")), "{key}");
    }
    assert!(plist.contains(&format!(
        "<string>{}:",
        home.join("releases/0.2.0/core").display()
    )));
    assert_eq!(
        fs::metadata(home.join("core.plist"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(
        ok(&stub, &home, &["start"]),
        json!({"running":true,"already_loaded":true})
    );
    let status = ok(&stub, &home, &["status"]);
    assert_eq!(
        (
            status["core_loaded"].clone(),
            status["core_healthy"].clone()
        ),
        (json!(true), json!(true))
    );
    assert_eq!(
        status["ports"],
        json!({"mimir":true,"sindri":true,"heimdall":true})
    );
    fs::write(home.join("access.json"), r#"{"heimdallToken":"t"}"#).unwrap();
    assert_eq!(ok(&stub, &home, &["access"]), json!({"heimdallToken":"t"}));

    // Stopping asks Mimir for its missions with the managed token, never on the command line.
    fs::create_dir_all(home.join("data/mimir")).unwrap();
    fs::write(home.join("data/mimir/auth-token"), "secret-token\n").unwrap();
    stub.write("missions.json", r#"{"missions":[{"status":"running"}]}"#);
    assert!(err(&stub, &home, &["stop"]).contains("Active or paused missions"));
    stub.write("missions.json", r#"{"missions":[{}]}"#);
    assert!(
        err(&stub, &home, &["stop"]).contains("Active or paused missions"),
        "an unknown status is active"
    );
    stub.write("missions.json", r#"{"error":"x"}"#);
    assert!(err(&stub, &home, &["stop"]).contains("Cannot determine active work"));
    stub.write("missions.json", "not json");
    assert!(err(&stub, &home, &["stop"]).contains("expected"));
    assert_eq!(
        fs::read_to_string(stub.state().join("last-header")).unwrap(),
        "Authorization: Bearer secret-token\n"
    );
    assert!(!stub.calls().contains("secret-token"));
    assert!(!home.join("auth-header.tmp").exists());
    stub.write("missions.json", r#"{"missions":[{"status":"completed"},{"status":"failed"},{"status":"cancelled"},{"status":"draft"}]}"#);
    assert_eq!(ok(&stub, &home, &["stop"]), json!({"stopped":true}));
    assert!(ports[..3]
        .iter()
        .all(|p| std::net::TcpStream::connect(("127.0.0.1", *p)).is_err()));
    assert!(err(&stub, &home, &["access"]).contains("not healthy"));
    // Mimir refusing the request also refuses the stop.
    listen_core(&stub, ports);
    ok(&stub, &home, &["start"]);
    fs::remove_file(stub.state().join("missions.json")).unwrap();
    assert!(err(&stub, &home, &["stop"]).contains("Command failed: refused"));
    fs::remove_file(home.join("data/mimir/auth-token")).unwrap();
    assert!(
        err(&stub, &home, &["stop"]).contains("No such file"),
        "a missing token fails closed"
    );
    fs::write(home.join("data/mimir/auth-token"), "t").unwrap();
    stub.write("missions.json", r#"{"missions":[]}"#);
    ok(&stub, &home, &["stop"]);
}

#[test]
fn start_refuses_unsafe_or_unhealthy_states() {
    let stub = Stub::new();
    let t = tempfile::tempdir().unwrap();
    let (home, ports) = managed(&stub, t.path());
    install(&stub, &home, t.path(), "0.2.0");
    write_json(&home.join("transaction.json"), &json!({})).unwrap();
    assert!(err(&stub, &home, &["start"]).contains("Interrupted update"));
    fs::remove_file(home.join("transaction.json")).unwrap();
    let busy = std::net::TcpListener::bind(("127.0.0.1", ports[1])).unwrap();
    assert!(err(&stub, &home, &["start"]).contains(&format!("Port {} is occupied", ports[1])));
    drop(busy);
    stub.flag("fail-bootstrap", true);
    assert!(err(&stub, &home, &["start"]).contains("bootstrap refused"));
    stub.flag("fail-bootstrap", false);
    // Loaded but not answering health checks.
    stub.flag(&format!("{}.loaded", label(&home, "core")), true);
    assert!(err(&stub, &home, &["start"]).contains("loaded but unhealthy"));
    assert_eq!(ok(&stub, &home, &["status"])["core_healthy"], false);
    stub.flag(&format!("{}.loaded", label(&home, "core")), false);
    // Ports open but health is not ok: the job is booted out after the wait.
    stub.write(
        "listen-core",
        &format!("{} {} {}", ports[0], ports[1], ports[2]),
    );
    assert!(err(&stub, &home, &["start"]).contains("did not become ready"));
    assert!(stub.calls().contains("launchctl bootout gui/"));
    assert!(!stub
        .state()
        .join(format!("{}.loaded", label(&home, "core")))
        .exists());
    // The release must still pass preflight at start.
    fs::remove_file(home.join("releases/0.2.0/core/outputs/heimdall/apps/server/main.mjs"))
        .unwrap();
    assert!(err(&stub, &home, &["start"]).contains("Missing runtime file"));
}

#[test]
fn skidbladnir_starts_separately_and_only_when_installed() {
    let stub = Stub::new();
    let t = tempfile::tempdir().unwrap();
    let (home, ports) = managed(&stub, t.path());
    install(&stub, &home, t.path(), "0.2.0");
    assert!(err(&stub, &home, &["start", "skidbladnir"]).contains("not installed"));
    let skid = vec![("apps/api/server.mjs", &b"// api"[..], 0o644)];
    let manifest = bundle_with(t.path(), "0.3.0", &[("skidbladnir", skid)]);
    ok(
        &stub,
        &home,
        &["install", manifest.to_str().unwrap(), "skidbladnir"],
    );
    let busy = std::net::TcpListener::bind(("127.0.0.1", ports[3])).unwrap();
    assert!(err(&stub, &home, &["start", "skidbladnir"]).contains("port is occupied"));
    drop(busy);
    stub.write("listen-skidbladnir", &ports[3].to_string());
    stub.flag("worker-ok", true);
    assert_eq!(
        ok(&stub, &home, &["start", "skidbladnir"]),
        json!({"started":true})
    );
    let plist = fs::read_to_string(stub.state().join("skidbladnir.plist.seen")).unwrap();
    assert!(plist.contains(&format!("<key>PORT</key><string>{}</string>", ports[3])));
    assert!(plist.contains(&format!("{}", home.join("data/skidbladnir").display())));
    assert_eq!(
        ok(&stub, &home, &["start", "skidbladnir"]),
        json!({"running":true})
    );
    assert_eq!(ok(&stub, &home, &["status"])["skidbladnir_loaded"], true);
    stub.flag("worker-ok", false);
    assert!(err(&stub, &home, &["start", "skidbladnir"]).contains("loaded but unhealthy"));
    // Stopping waits for the worker port too.
    assert_eq!(ok(&stub, &home, &["stop"]), json!({"stopped":true}));
    assert!(std::net::TcpStream::connect(("127.0.0.1", ports[3])).is_err());
    assert!(err(&stub, &home, &["start", "skidbladnir"]).contains("did not become ready"));
    assert!(!stub
        .state()
        .join(format!("{}.loaded", label(&home, "skidbladnir")))
        .exists());
}

#[test]
fn install_refuses_bad_input_and_cleans_up_failed_staging() {
    let stub = Stub::new();
    let t = tempfile::tempdir().unwrap();
    let (home, _) = managed(&stub, t.path());
    let manifest = bundle_with(t.path(), "0.2.0", &[]);
    let path = manifest.to_str().unwrap();
    fs::write(t.path().join("bad.json"), r#"{"schema":2}"#).unwrap();
    assert!(err(
        &stub,
        &home,
        &["install", t.path().join("bad.json").to_str().unwrap()]
    )
    .contains("missing field"));
    assert!(err(
        &stub,
        &home,
        &["install", t.path().join("absent.json").to_str().unwrap()]
    )
    .contains("No such file"));
    // Preflight runs the bundled node: one that reports Node 24 is refused and staging is removed.
    let old = bundle_with(t.path(), "0.1.0", &[]);
    let archive = t.path().join("core-0.1.0.zip");
    let sha = zip_files(&archive, &core_files(b"#!/bin/sh\nprintf '24\\n'\n"));
    let mut m: Value = read_json(&old).unwrap();
    m["packages"][0]["sha256"] = json!(sha);
    write_json(&old, &m).unwrap();
    assert!(
        err(&stub, &home, &["install", old.to_str().unwrap()]).contains("Bundled Node is too old")
    );
    assert!(!home.join("releases/0.1.0.staging").exists() && !home.join("releases/0.1.0").exists());
    // A leftover staging directory from a crash is replaced.
    fs::create_dir_all(home.join("releases/0.2.0.staging/junk")).unwrap();
    ok(&stub, &home, &["install", path]);
    assert!(!home.join("releases/0.2.0.staging").exists());
    assert!(err(&stub, &home, &["install", path]).contains("already exists"));
    // An installation recorded with another data schema is never updated in place.
    let mut receipt: Value = read_json(&home.join("current.json")).unwrap();
    receipt["data_schema"] = json!(2);
    write_json(&home.join("current.json"), &receipt).unwrap();
    let next = bundle_with(t.path(), "0.6.0", &[]);
    assert!(err(&stub, &home, &["install", next.to_str().unwrap()])
        .contains("Data migration is not supported"));
    receipt["data_schema"] = json!(1);
    write_json(&home.join("current.json"), &receipt).unwrap();
    let mut m: Value = read_json(&manifest).unwrap();
    m["packages"][0]["archive"] = json!("missing.zip");
    m["version"] = json!("0.5.0");
    write_json(&manifest, &m).unwrap();
    assert!(err(&stub, &home, &["install", path]).contains("No such file"));
    write_json(&home.join("transaction.json"), &json!({})).unwrap();
    assert!(err(&stub, &home, &["install", path]).contains("Recover the interrupted update"));
}

#[test]
fn a_running_factory_is_restarted_on_the_new_release() {
    let stub = Stub::new();
    let t = tempfile::tempdir().unwrap();
    let (home, ports) = managed(&stub, t.path());
    install(&stub, &home, t.path(), "0.2.0");
    listen_core(&stub, ports);
    ok(&stub, &home, &["start"]);
    stub.write("missions.json", r#"{"missions":[]}"#);
    fs::create_dir_all(home.join("data/mimir")).unwrap();
    fs::write(home.join("data/mimir/auth-token"), "t").unwrap();
    let result = install(&stub, &home, t.path(), "0.3.0");
    assert_eq!(result["running"], true);
    assert_eq!(result["installed"]["version"], "0.3.0");
    assert!(fs::read_to_string(stub.state().join("core.plist.seen"))
        .unwrap()
        .contains("releases/0.3.0"));
    assert!(!home.join("transaction.json").exists());
    ok(&stub, &home, &["stop"]);
}

#[test]
fn failed_activation_restores_data_pointer_and_rollback_target() {
    let stub = Stub::new();
    let t = tempfile::tempdir().unwrap();
    let (home, ports) = managed(&stub, t.path());
    install(&stub, &home, t.path(), "0.2.0");
    install(&stub, &home, t.path(), "0.3.0");
    let target: Value = read_json(&home.join("previous.json")).unwrap();
    assert_eq!(target["receipt"]["version"], "0.2.0");
    listen_core(&stub, ports);
    ok(&stub, &home, &["start"]);
    stub.write("missions.json", r#"{"missions":[]}"#);
    fs::create_dir_all(home.join("data/mimir")).unwrap();
    fs::write(home.join("data/mimir/auth-token"), "t").unwrap();
    fs::write(home.join("data/project.txt"), "before").unwrap();
    stub.flag("fail-bootstrap", true);
    let manifest = bundle_with(t.path(), "0.4.0", &[]);
    let message = err(&stub, &home, &["install", manifest.to_str().unwrap()]);
    assert!(
        message.contains("Activation failed and prior data restored"),
        "{message}"
    );
    assert_eq!(
        ok(&stub, &home, &["status"])["installation"]["version"],
        "0.3.0"
    );
    assert_eq!(
        fs::read_to_string(home.join("data/project.txt")).unwrap(),
        "before"
    );
    assert!(!home.join("transaction.json").exists());
    // The rollback target is still the release before 0.3.0, not 0.3.0 itself.
    let after: Value = read_json(&home.join("previous.json")).unwrap();
    assert_eq!(after, target);
    stub.flag("fail-bootstrap", false);
    stub.flag("health-ok", true);
    ok(&stub, &home, &["rollback"]);
    assert_eq!(
        ok(&stub, &home, &["status"])["installation"]["version"],
        "0.2.0"
    );
}

#[test]
fn failed_worker_activation_stops_and_restores() {
    let stub = Stub::new();
    let t = tempfile::tempdir().unwrap();
    let (home, ports) = managed(&stub, t.path());
    let skid = || vec![("apps/api/server.mjs", &b"// api"[..], 0o644)];
    let first = bundle_with(t.path(), "0.2.0", &[("skidbladnir", skid())]);
    ok(
        &stub,
        &home,
        &["install", first.to_str().unwrap(), "skidbladnir"],
    );
    stub.write("listen-skidbladnir", &ports[3].to_string());
    stub.flag("worker-ok", true);
    ok(&stub, &home, &["start", "skidbladnir"]);
    stub.flag("fail-bootstrap", true);
    let next = bundle_with(t.path(), "0.3.0", &[("skidbladnir", skid())]);
    let message = err(
        &stub,
        &home,
        &["install", next.to_str().unwrap(), "skidbladnir"],
    );
    assert!(
        message.contains("Worker service activation failed"),
        "{message}"
    );
    assert_eq!(
        ok(&stub, &home, &["status"])["installation"]["version"],
        "0.2.0"
    );
    assert!(
        !home.join("previous.json").exists(),
        "the first install had no rollback target"
    );
}

#[test]
fn recover_restores_an_interrupted_activation_and_its_rollback_target() {
    let stub = Stub::new();
    let t = tempfile::tempdir().unwrap();
    let (home, _) = managed(&stub, t.path());
    assert_eq!(ok(&stub, &home, &["recover"]), json!({"recovered":false}));
    install(&stub, &home, t.path(), "0.2.0");
    install(&stub, &home, t.path(), "0.3.0");
    let older: Value = read_json(&home.join("previous.json")).unwrap();
    fs::write(home.join("data/project.txt"), "0.3 data").unwrap();
    install(&stub, &home, t.path(), "0.4.0");
    // Recreate the journal as an activation of 0.4.0 interrupted after the pointer change.
    let replaced: Value = read_json(&home.join("previous.json")).unwrap();
    write_json(
        &home.join("transaction.json"),
        &json!({"previous":replaced["receipt"],"next":ok(&stub, &home, &["status"])["installation"],"backup":replaced["backup"],"previous_pointer":older}),
    )
    .unwrap();
    fs::write(home.join("data/project.txt"), "partial").unwrap();
    assert!(err(
        &stub,
        &home,
        &[
            "install",
            bundle_with(t.path(), "0.5.0", &[]).to_str().unwrap()
        ]
    )
    .contains("Recover"));
    assert_eq!(ok(&stub, &home, &["recover"]), json!({"recovered":true}));
    assert_eq!(
        ok(&stub, &home, &["status"])["installation"]["version"],
        "0.3.0"
    );
    assert_eq!(
        fs::read_to_string(home.join("data/project.txt")).unwrap(),
        "0.3 data"
    );
    assert_eq!(
        read_json::<Value>(&home.join("previous.json")).unwrap(),
        older
    );
    // A first-install journal removes the pointer entirely.
    write_json(
        &home.join("transaction.json"),
        &json!({"previous":null,"previous_pointer":null}),
    )
    .unwrap();
    ok(&stub, &home, &["recover"]);
    assert!(!home.join("current.json").exists() && !home.join("previous.json").exists());
}

#[test]
fn rollback_refuses_receipts_and_backups_outside_the_installation() {
    let stub = Stub::new();
    let t = tempfile::tempdir().unwrap();
    let (home, _) = managed(&stub, t.path());
    install(&stub, &home, t.path(), "0.2.0");
    install(&stub, &home, t.path(), "0.3.0");
    let previous: Value = read_json(&home.join("previous.json")).unwrap();
    // A receipt version naming a directory outside releases would make preflight run its node.
    let marker = t.path().join("ran");
    let evil = home.join("evil/core");
    for file in RUNTIME {
        fs::create_dir_all(evil.join(file).parent().unwrap()).unwrap();
        fs::write(
            evil.join(file),
            format!("#!/bin/sh\ntouch {}\nprintf '26\\n'\n", marker.display()),
        )
        .unwrap();
        fs::set_permissions(evil.join(file), fs::Permissions::from_mode(0o755)).unwrap();
    }
    let mut tampered = previous.clone();
    tampered["receipt"]["version"] = json!("../evil");
    write_json(&home.join("previous.json"), &tampered).unwrap();
    assert!(err(&stub, &home, &["rollback"]).contains("Invalid rollback receipt"));
    assert!(!marker.exists(), "nothing outside releases was executed");
    // A backup path that leaves backups through `..` is not restored.
    let outside = home.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("project.txt"), "foreign").unwrap();
    fs::write(home.join("data/project.txt"), "mine").unwrap();
    let mut tampered = previous.clone();
    tampered["backup"] = json!(home.join("backups/../outside"));
    write_json(&home.join("previous.json"), &tampered).unwrap();
    assert!(err(&stub, &home, &["rollback"]).contains("Invalid recovery backup"));
    assert_eq!(
        fs::read_to_string(home.join("data/project.txt")).unwrap(),
        "mine"
    );
    let mut tampered = previous.clone();
    tampered["backup"] = json!(home.join("backups"));
    fs::remove_file(home.join("transaction.json")).unwrap();
    write_json(&home.join("previous.json"), &tampered).unwrap();
    assert!(err(&stub, &home, &["rollback"]).contains("Invalid recovery backup"));
    fs::remove_file(home.join("transaction.json")).unwrap();
    let mut tampered = previous.clone();
    tampered["backup"] = Value::Null;
    write_json(&home.join("previous.json"), &tampered).unwrap();
    assert!(err(&stub, &home, &["rollback"]).contains("Missing backup"));
    fs::remove_file(home.join("transaction.json")).unwrap();
    write_json(&home.join("previous.json"), &previous).unwrap();
    // An unprepared data.restore from an earlier crash is replaced.
    fs::create_dir_all(home.join("data.restore/stale")).unwrap();
    ok(&stub, &home, &["rollback"]);
    assert_eq!(
        ok(&stub, &home, &["status"])["installation"]["version"],
        "0.2.0"
    );
    assert!(!home.join("data.restore").exists());
}

#[test]
fn uninstall_removes_releases_and_keeps_data() {
    let stub = Stub::new();
    let t = tempfile::tempdir().unwrap();
    let (home, _) = managed(&stub, t.path());
    install(&stub, &home, t.path(), "0.2.0");
    install(&stub, &home, t.path(), "0.3.0");
    fs::write(home.join("data/keep"), "x").unwrap();
    write_json(&home.join("transaction.json"), &json!({})).unwrap();
    let result = ok(&stub, &home, &["uninstall", "--confirm"]);
    assert_eq!(result["uninstalled"], true);
    assert_eq!(fs::read_dir(home.join("releases")).unwrap().count(), 0);
    for f in ["current.json", "previous.json", "transaction.json"] {
        assert!(!home.join(f).exists(), "{f}");
    }
    assert!(home.join("data/keep").exists());
    ok(&stub, &home, &["uninstall", "--confirm"]);
}

const REPOS: [&str; 8] = [
    "Viking-Software-Factory",
    "Mimir",
    "Sindri",
    "Brokkr",
    "Heimdall",
    "Skidbladnir",
    "Hulder",
    "Bifrost",
];
fn asset(name: &str, tag: &str) -> Value {
    json!({"name":name,"browser_download_url":format!("https://github.com/ChaosDeSelva/Viking-Software-Factory/releases/download/{tag}/{name}")})
}
/// Publishes a signed release `tag` of a bundle built in `base` through the stubbed GitHub.
fn publish(
    stub: &Stub,
    base: &std::path::Path,
    version: &str,
    key: &ring::signature::Ed25519KeyPair,
) -> Value {
    use base64::Engine;
    let manifest = bundle_with(base, version, &[]);
    let bytes = fs::read(&manifest).unwrap();
    let assets = stub.state().join("assets");
    fs::write(assets.join("factory-manifest.json"), &bytes).unwrap();
    let signature = base64::engine::general_purpose::STANDARD.encode(key.sign(&bytes).as_ref());
    fs::write(assets.join("factory-manifest.sig"), signature).unwrap();
    let archive = format!("core-{version}.zip");
    fs::copy(base.join(&archive), assets.join(&archive)).unwrap();
    let tag = format!("v{version}");
    json!({"draft":false,"prerelease":false,"tag_name":tag,"assets":[asset("factory-manifest.json",&tag),asset("factory-manifest.sig",&tag),asset(&archive,&tag)]})
}
fn trusted(home: &std::path::Path) -> ring::signature::Ed25519KeyPair {
    use base64::Engine;
    use ring::signature::KeyPair;
    let doc =
        ring::signature::Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap();
    let pair = ring::signature::Ed25519KeyPair::from_pkcs8(doc.as_ref()).unwrap();
    let mut cfg: Value = read_json(&home.join("config.json")).unwrap();
    cfg["update_key"] =
        json!(base64::engine::general_purpose::STANDARD.encode(pair.public_key().as_ref()));
    write_json(&home.join("config.json"), &cfg).unwrap();
    pair
}

#[test]
fn update_check_reports_each_feed_caches_and_follows_the_installation() {
    let stub = Stub::new();
    let t = tempfile::tempdir().unwrap();
    let (home, _) = managed(&stub, t.path());
    // Every feed unavailable: nothing is advertised.
    let offline = ok(&stub, &home, &["update", "check"]);
    assert_eq!(
        (offline["available"].clone(), offline["installable"].clone()),
        (json!(false), json!(false))
    );
    for (entry, repo) in offline["repositories"]
        .as_array()
        .unwrap()
        .iter()
        .zip(REPOS)
    {
        assert_eq!(
            entry,
            &json!({"repo":repo,"error":"GitHub unavailable or rate limited"})
        );
    }
    stub.write("github/Viking-Software-Factory.json", &json!([
        {"draft":false,"prerelease":false,"tag_name":"v0.3.0","assets":[{"name":"factory-manifest.json"},{"name":"factory-manifest.sig"}]},
        {"draft":false,"prerelease":true,"tag_name":"v0.4.0-beta.1","assets":[]},
    ]).to_string());
    stub.write(
        "github/Mimir.json",
        r#"[{"draft":false,"prerelease":false,"tag_name":"not-semver"}]"#,
    );
    // A fresh cache is served without asking GitHub again.
    let before = stub.calls().matches("api.github.com").count();
    assert_eq!(ok(&stub, &home, &["update", "check"])["available"], false);
    assert_eq!(stub.calls().matches("api.github.com").count(), before);
    let preview = ok(&stub, &home, &["update", "check", "--force"]);
    assert_eq!(preview["candidate"]["tag_name"], "v0.4.0-beta.1");
    assert_eq!(
        (preview["available"].clone(), preview["installable"].clone()),
        (json!(true), json!(false))
    );
    assert_eq!(
        preview["repositories"][1],
        json!({"repo":"Mimir","release":null})
    );
    ok(&stub, &home, &["channel", "stable"]);
    let stable = ok(&stub, &home, &["update", "check"]);
    assert_eq!(stable["candidate"]["tag_name"], "v0.3.0");
    assert_eq!(
        (stable["available"].clone(), stable["installable"].clone()),
        (json!(true), json!(true))
    );
    // Installing the advertised version makes the cached answer stale; it must not advertise it again.
    install(&stub, &home, t.path(), "0.3.0");
    let cached = ok(&stub, &home, &["update", "check"]);
    assert_eq!(cached["checked_at"], stable["checked_at"]);
    assert_eq!(cached["available"], false);
    // An expired cache is refreshed; a malformed feed is an error rather than "no update".
    let mut old: Value = read_json(&home.join("updates.json")).unwrap();
    old["checked_at"] = json!(0);
    write_json(&home.join("updates.json"), &old).unwrap();
    stub.write("github/Sindri.json", "{\"message\":\"Not Found\"}");
    assert!(err(&stub, &home, &["update", "check"]).contains("invalid type"));
}

#[test]
fn update_apply_installs_only_a_signed_matching_newer_release() {
    let stub = Stub::new();
    let t = tempfile::tempdir().unwrap();
    let (home, _) = managed(&stub, t.path());
    assert!(err(&stub, &home, &["update", "apply"]).contains("No trusted update public key"));
    let key = trusted(&home);
    install(&stub, &home, t.path(), "0.2.0");
    let feed = |release: &Value| {
        stub.write(
            "github/Viking-Software-Factory.json",
            &json!([release]).to_string(),
        )
    };
    let release = publish(&stub, t.path(), "0.3.0", &key);
    // Each refusal leaves 0.2.0 installed.
    type Setup<'a> = Box<dyn Fn() + 'a>;
    let refusals: Vec<(Setup, &str)> = vec![
        (
            Box::new(|| {
                feed(&json!({"draft":false,"prerelease":false,"tag_name":"v0.1.0","assets":[]}))
            }),
            "No newer compatible factory release",
        ),
        (
            Box::new(|| {
                let mut r = release.clone();
                r["assets"] = json!([]);
                feed(&r);
            }),
            "Source only releases cannot be installed",
        ),
        (
            Box::new(|| {
                let mut r = release.clone();
                r.as_object_mut().unwrap().remove("assets");
                feed(&r);
            }),
            "Release has no assets",
        ),
        (
            Box::new(|| {
                let mut r = release.clone();
                r["assets"][0]["browser_download_url"] =
                    json!("https://example.com/factory-manifest.json");
                feed(&r);
            }),
            "Unexpected release asset origin",
        ),
        (
            Box::new(|| {
                let mut r = release.clone();
                r["assets"][0]["browser_download_url"] = json!(7);
                feed(&r);
            }),
            "Invalid asset URL",
        ),
        (
            Box::new(|| {
                let mut r = release.clone();
                r["tag_name"] = json!("v0.3.1");
                feed(&r);
            }),
            "Release identity or channel does not match",
        ),
        (
            Box::new(|| {
                feed(&release);
                fs::write(stub.state().join("assets/factory-manifest.sig"), "AAAA").unwrap();
            }),
            "signature is invalid",
        ),
    ];
    for (setup, message) in refusals {
        setup();
        let e = err(&stub, &home, &["update", "apply"]);
        assert!(e.contains(message), "{message}: {e}");
        assert_eq!(
            ok(&stub, &home, &["status"])["installation"]["version"],
            "0.2.0"
        );
    }
    let release = publish(&stub, t.path(), "0.3.0", &key);
    feed(&release);
    ok(&stub, &home, &["channel", "stable"]);
    let m: Value = read_json(&stub.state().join("assets/factory-manifest.json")).unwrap();
    assert_eq!(m["channel"], "preview");
    // A stable channel refuses a preview manifest even when correctly signed.
    assert!(err(&stub, &home, &["update", "apply"]).contains("channel does not match"));
    ok(&stub, &home, &["channel", "preview"]);
    let applied = ok(&stub, &home, &["update", "apply"]);
    assert_eq!(applied["installed"]["version"], "0.3.0");
    assert!(stub.calls().contains("--proto =https --proto-redir =https"));
}

#[test]
fn recover_finishes_a_first_install_interrupted_before_its_pointer_was_written() {
    let stub = Stub::new();
    let t = tempfile::tempdir().unwrap();
    let (home, _) = managed(&stub, t.path());
    // The journal is written before current.json; a crash between the two leaves no pointer.
    write_json(
        &home.join("transaction.json"),
        &json!({"previous":null,"next":{"version":"0.2.0","data_schema":1,"components":["core"],"installed_at":1},"backup":home.join("backups/before-0.2.0-1"),"previous_pointer":null}),
    )
    .unwrap();
    assert!(!home.join("current.json").exists());
    assert_eq!(ok(&stub, &home, &["recover"]), json!({"recovered":true}));
    assert!(!home.join("transaction.json").exists());
    assert!(ok(&stub, &home, &["status"])["installation"].is_null());
}

#[test]
fn a_release_whose_activation_failed_can_be_installed_again() {
    let stub = Stub::new();
    let t = tempfile::tempdir().unwrap();
    let (home, ports) = managed(&stub, t.path());
    install(&stub, &home, t.path(), "0.2.0");
    listen_core(&stub, ports);
    ok(&stub, &home, &["start"]);
    stub.write("missions.json", r#"{"missions":[]}"#);
    fs::create_dir_all(home.join("data/mimir")).unwrap();
    fs::write(home.join("data/mimir/auth-token"), "t").unwrap();
    stub.flag("fail-bootstrap", true);
    let manifest = bundle_with(t.path(), "0.3.0", &[]);
    let message = err(&stub, &home, &["install", manifest.to_str().unwrap()]);
    assert!(message.contains("Activation failed"), "{message}");
    assert!(
        !home.join("releases/0.3.0").exists(),
        "a release that never became current is not kept"
    );
    // Once the cause is fixed the same release installs; update apply offers no other version.
    stub.flag("fail-bootstrap", false);
    let installed = ok(&stub, &home, &["install", manifest.to_str().unwrap()]);
    assert_eq!(installed["installed"]["version"], "0.3.0");
    assert!(
        home.join("releases/0.2.0").exists(),
        "the rollback target stays"
    );
}
