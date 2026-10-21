use serde_json::json;
use std::{
    env, fs,
    path::PathBuf,
    process::{Command, ExitCode},
};
use viking_manager::{write_json, Config, Manager, Result};
fn main() -> ExitCode {
    match execute() {
        Ok(v) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&v).unwrap_or_else(|_| "{}".into())
            );
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("{}", json!({"error":e.to_string()}));
            ExitCode::FAILURE
        }
    }
}
fn execute() -> Result<serde_json::Value> {
    let mut args: Vec<String> = env::args().skip(1).filter(|a| a != "--json").collect();
    let mut root = PathBuf::from(env::var("VIKING_HOME").unwrap_or(format!(
        "{}/Library/Application Support/Viking Factory",
        env::var("HOME")?
    )));
    if let Some(i) = args.iter().position(|s| s == "--home") {
        if i + 1 >= args.len() {
            return Err("--home needs a directory".into());
        }
        root = PathBuf::from(args.remove(i + 1));
        args.remove(i);
    }
    let command = args.first().map(String::as_str).unwrap_or("help");
    if command == "help" || command == "--help" {
        return Ok(
            json!({"commands":["status","doctor","install <manifest.json> [skidbladnir hulder bifrost]","start","start skidbladnir","stop","logs [core|skidbladnir]","update check [--force]","update apply","channel <stable|preview>","rollback","recover","uninstall --confirm","open <heimdall|hulder|companion|data>","diagnostics <output.json>","config path <PATH>","config ports <mimir> <sindri> <heimdall> <skidbladnir>"],"note":"Local manifests are trusted executable software. Remote updates require an Ed25519 trusted key. All commands support --home."}),
        );
    }
    let manager = Manager::open(root)?;
    match command {
        "access" => {
            if !manager.healthy() {
                return Err("Factory is not healthy".into());
            }
            viking_manager::read_json(&manager.root.join("access.json"))
        }
        "status" => manager.status(),
        "doctor" => manager.doctor(),
        "install" => manager.install(
            &PathBuf::from(args.get(1).ok_or("Provide a local manifest file")?),
            args.get(2..).unwrap_or_default(),
        ),
        "start" => {
            if args.get(1).map(String::as_str) == Some("skidbladnir") {
                manager.start_skidbladnir()
            } else {
                manager.start()
            }
        }
        "stop" => manager.stop(),
        "rollback" => manager.rollback(),
        "recover" => manager.recover(),
        "update" => match args.get(1).map(String::as_str) {
            Some("check") => manager.update_check(args.iter().any(|a| a == "--force")),
            Some("apply") => manager.update_apply(),
            _ => Err("Use update check or update apply".into()),
        },
        "channel" => {
            let mut config = manager.config()?;
            let c = args.get(1).ok_or("Choose stable or preview")?;
            if !["stable", "preview"].contains(&c.as_str()) {
                return Err("Choose stable or preview".into());
            }
            config.channel = c.clone();
            write_json(&manager.root.join("config.json"), &config)?;
            let cache = manager.root.join("updates.json");
            if cache.exists() {
                fs::remove_file(cache)?;
            }
            Ok(json!({"channel":c}))
        }
        "config" => {
            let mut c: Config = manager.config()?;
            if manager.running("core") || manager.running("skidbladnir") {
                return Err("Stop managed services before changing configuration".into());
            }
            match args.get(1).map(String::as_str) {
                Some("path") => {
                    c.path = args.get(2).ok_or("Provide PATH")?.clone();
                }
                Some("ports") => {
                    if args.len() != 6 {
                        return Err("Provide four ports".into());
                    }
                    let p: Vec<u16> = args[2..]
                        .iter()
                        .map(|s| s.parse())
                        .collect::<std::result::Result<_, _>>()?;
                    if p.iter().any(|p| *p < 1024)
                        || p.iter().collect::<std::collections::BTreeSet<_>>().len() != 4
                    {
                        return Err("Use four distinct unprivileged ports".into());
                    }
                    c.mimir_port = p[0];
                    c.sindri_port = p[1];
                    c.heimdall_port = p[2];
                    c.skidbladnir_port = p[3];
                }
                _ => return Err("Use config path or config ports".into()),
            };
            write_json(&manager.root.join("config.json"), &c)?;
            Ok(json!({"configured":true}))
        }
        "uninstall" => {
            if !args.iter().any(|a| a == "--confirm") {
                return Err(
                    "Use uninstall --confirm. Project data and backups will be retained.".into(),
                );
            }
            manager.uninstall()
        }
        "logs" => {
            let service = args.get(1).map(String::as_str).unwrap_or("core");
            if !["core", "skidbladnir"].contains(&service) {
                return Err("Unknown service".into());
            }
            let log = fs::read_to_string(manager.root.join("logs").join(format!("{service}.log")))?;
            Ok(
                json!({"local_log":log.lines().rev().take(150).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"),"warning":"Local logs may contain project data. Do not publish raw logs."}),
            )
        }
        "diagnostics" => {
            let p = PathBuf::from(args.get(1).ok_or("Provide output path")?);
            let s = manager.status()?;
            let report = json!({"manager_version":env!("CARGO_PKG_VERSION"),"installation":s["installation"],"core_loaded":s["core_loaded"],"ports":s["ports"],"pending_recovery":s["pending_recovery"],"channel":s["channel"],"note":"Allowlisted metadata only. No paths, environment, tokens, project data or logs included."});
            write_json(&p, &report)?;
            Ok(json!({"exported":p}))
        }
        "open" => {
            let c = manager.config()?;
            let target = match args.get(1).map(String::as_str) {
                Some("heimdall") => format!("http://127.0.0.1:{}", c.heimdall_port),
                Some("hulder") => manager
                    .release()?
                    .join("hulder/Hulder.app")
                    .display()
                    .to_string(),
                Some("companion") => manager
                    .release()?
                    .join("companion/Viking Factory.app")
                    .display()
                    .to_string(),
                Some("data") => manager.root.join("data").display().to_string(),
                _ => return Err("Choose heimdall, hulder, companion or data".into()),
            };
            let mut opener = Command::new("open");
            if args.get(1).map(String::as_str) == Some("companion") {
                opener.arg("-n");
            }
            if !opener.arg(target).status()?.success() {
                return Err("Could not open target".into());
            }
            Ok(json!({"opened":true}))
        }
        _ => Err("Unknown command. Run viking help.".into()),
    }
}
