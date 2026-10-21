use serde_json::json;
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path};
use viking_manager::*;
use zip::{write::SimpleFileOptions as FileOptions, ZipWriter};
fn bundle(base: &Path, version: &str) -> std::path::PathBuf {
    let archive = base.join(format!("core-{version}.zip"));
    let mut z = ZipWriter::new(fs::File::create(&archive).unwrap());
    for name in [
        "node",
        "outputs/local-factory/factory.mjs",
        "work/ecosystem/mimir/apps/server/dist/start.js",
        "work/ecosystem/sindri/apps/server/dist/boot.js",
        "outputs/heimdall/apps/server/main.mjs",
    ] {
        z.start_file(name, FileOptions::default().unix_permissions(0o755))
            .unwrap();
        z.write_all(if name == "node" {
            b"#!/bin/sh\nprintf '26\\n'\n"
        } else {
            b"// test"
        })
        .unwrap();
    }
    z.finish().unwrap();
    let m = Manifest {
        schema: 1,
        version: version.into(),
        channel: "preview".into(),
        platform: "macos-arm64".into(),
        data_schema: 1,
        packages: vec![Package {
            id: "core".into(),
            version: version.into(),
            archive: archive.file_name().unwrap().to_str().unwrap().into(),
            sha256: format!("{:x}", Sha256::digest(fs::read(archive).unwrap())),
            required: true,
        }],
    };
    let path = base.join(format!("{version}.json"));
    write_json(&path, &m).unwrap();
    path
}
fn manager(base: &Path) -> Manager {
    let m = Manager::open(base.join("managed")).unwrap();
    let mut cfg = m.config().unwrap();
    cfg.mimir_port = 49671;
    cfg.sindri_port = 49672;
    cfg.heimdall_port = 49673;
    cfg.skidbladnir_port = 49674;
    write_json(&m.root.join("config.json"), &cfg).unwrap();
    m
}
#[test]
fn install_update_rollback_preserve_data() {
    let t = tempfile::tempdir().unwrap();
    let m = manager(t.path());
    m.install(&bundle(t.path(), "0.2.0"), &[]).unwrap();
    fs::write(m.root.join("data/project.txt"), "old").unwrap();
    m.install(&bundle(t.path(), "0.3.0"), &[]).unwrap();
    fs::write(m.root.join("data/project.txt"), "new").unwrap();
    m.rollback().unwrap();
    assert_eq!(m.current().unwrap().unwrap().version, "0.2.0");
    assert_eq!(
        fs::read_to_string(m.root.join("data/project.txt")).unwrap(),
        "old"
    );
    assert_eq!(fs::read_dir(m.root.join("backups")).unwrap().count(), 2);
    m.uninstall().unwrap();
    assert!(m.root.join("data/project.txt").exists());
}
#[test]
fn corrupt_package_never_replaces_current() {
    let t = tempfile::tempdir().unwrap();
    let m = manager(t.path());
    m.install(&bundle(t.path(), "0.2.0"), &[]).unwrap();
    let next = bundle(t.path(), "0.3.0");
    fs::write(t.path().join("core-0.3.0.zip"), "corrupt").unwrap();
    assert!(m.install(&next, &[]).is_err());
    assert_eq!(m.current().unwrap().unwrap().version, "0.2.0");
    assert!(!m.root.join("releases/0.3.0.staging").exists());
}
#[test]
fn refuses_migration_and_unknown_optional() {
    let t = tempfile::tempdir().unwrap();
    let m = manager(t.path());
    let path = bundle(t.path(), "0.2.0");
    assert!(m.install(&path, &["unknown".into()]).is_err());
    let mut mf: Manifest = read_json(&path).unwrap();
    mf.data_schema = 2;
    write_json(&path, &mf).unwrap();
    assert!(m.install(&path, &[]).is_err());
    assert!(m.current().unwrap().is_none());
}
#[test]
fn interrupted_pointer_change_recovers() {
    let t = tempfile::tempdir().unwrap();
    let m = manager(t.path());
    m.install(&bundle(t.path(), "0.2.0"), &[]).unwrap();
    let old = m.current().unwrap().unwrap();
    let backup = m.root.join("backups/interrupted");
    fs::create_dir(&backup).unwrap();
    fs::write(backup.join("proof"), "prior").unwrap();
    write_json(
        &m.root.join("transaction.json"),
        &json!({"previous":old,"backup":backup}),
    )
    .unwrap();
    m.recover().unwrap();
    assert_eq!(
        fs::read_to_string(m.root.join("data/proof")).unwrap(),
        "prior"
    );
    assert!(!m.root.join("transaction.json").exists());
}
#[test]
fn exclusive_operations() {
    let t = tempfile::tempdir().unwrap();
    let m = manager(t.path());
    assert!(Manager::open(m.root.clone()).is_err());
}
#[test]
fn release_selection_respects_channel_and_version() {
    let r = vec![
        json!({"draft":false,"prerelease":true,"tag_name":"v0.3.0-beta.1"}),
        json!({"draft":false,"prerelease":false,"tag_name":"v0.2.0"}),
        json!({"draft":true,"prerelease":false,"tag_name":"v9.0.0"}),
    ];
    assert_eq!(select_release(&r, "stable").unwrap()["tag_name"], "v0.2.0");
    assert_eq!(
        select_release(&r, "preview").unwrap()["tag_name"],
        "v0.3.0-beta.1"
    );
}
#[test]
fn signatures_authenticate_exact_manifest() {
    use base64::Engine;
    use ring::{
        rand::SystemRandom,
        signature::{Ed25519KeyPair, KeyPair},
    };
    let doc = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
    let pair = Ed25519KeyPair::from_pkcs8(doc.as_ref()).unwrap();
    let b = base64::engine::general_purpose::STANDARD;
    let key = b.encode(pair.public_key().as_ref());
    let sig = b.encode(pair.sign(b"approved").as_ref());
    assert!(verify_signature(b"approved", &sig, &key).is_ok());
    assert!(verify_signature(b"changed", &sig, &key).is_err());
}
#[test]
fn archive_traversal_is_rejected() {
    let t = tempfile::tempdir().unwrap();
    let path = t.path().join("bad.zip");
    let mut z = ZipWriter::new(fs::File::create(&path).unwrap());
    z.start_file("../outside", FileOptions::default()).unwrap();
    z.write_all(b"bad").unwrap();
    z.finish().unwrap();
    let hash = format!("{:x}", Sha256::digest(fs::read(&path).unwrap()));
    assert!(extract_zip(&path, &t.path().join("output"), &hash).is_err());
    assert!(!t.path().join("outside").exists());
}
#[test]
fn untrusted_update_has_no_install_side_effect() {
    let t = tempfile::tempdir().unwrap();
    let m = manager(t.path());
    assert!(m
        .update_apply()
        .unwrap_err()
        .to_string()
        .contains("trusted update"));
    assert!(m.current().unwrap().is_none());
}
#[test]
fn occupied_unmanaged_port_is_never_stopped() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let t = tempfile::tempdir().unwrap();
    let m = manager(t.path());
    let mut c = m.config().unwrap();
    c.mimir_port = listener.local_addr().unwrap().port();
    write_json(&m.root.join("config.json"), &c).unwrap();
    assert!(m.stop().unwrap_err().to_string().contains("unmanaged"));
    assert!(std::net::TcpStream::connect(listener.local_addr().unwrap()).is_ok());
}

#[test]
fn internal_links_work_but_escaping_links_fail() {
    for target in ["real.txt", "../../outside"] {
        let t = tempfile::tempdir().unwrap();
        let path = t.path().join("links.zip");
        let mut z = ZipWriter::new(fs::File::create(&path).unwrap());
        z.start_file("real.txt", FileOptions::default()).unwrap();
        z.write_all(b"content").unwrap();
        z.add_symlink("link.txt", target, FileOptions::default())
            .unwrap();
        z.finish().unwrap();
        let hash = format!("{:x}", Sha256::digest(fs::read(&path).unwrap()));
        let output = t.path().join("output");
        let result = extract_zip(&path, &output, &hash);
        if target == "real.txt" {
            result.unwrap();
            assert_eq!(fs::read(output.join("link.txt")).unwrap(), b"content");
        } else {
            assert!(result.is_err());
        }
    }
}

#[test]
fn refuses_existing_unmanaged_directory() {
    let t = tempfile::tempdir().unwrap();
    fs::write(t.path().join("important.txt"), "keep").unwrap();
    assert!(Manager::open(t.path().to_path_buf()).is_err());
    assert_eq!(
        fs::read_to_string(t.path().join("important.txt")).unwrap(),
        "keep"
    );
    assert!(!t.path().join("manager.lock").exists());
}

#[test]
fn rollback_failure_keeps_recoverable_journal() {
    let t = tempfile::tempdir().unwrap();
    let m = manager(t.path());
    m.install(&bundle(t.path(), "0.2.0"), &[]).unwrap();
    m.install(&bundle(t.path(), "0.3.0"), &[]).unwrap();
    let mut previous: serde_json::Value = read_json(&m.root.join("previous.json")).unwrap();
    previous["backup"] = json!(m.root.join("backups/missing"));
    write_json(&m.root.join("previous.json"), &previous).unwrap();
    assert!(m.rollback().is_err());
    assert!(m.root.join("transaction.json").exists());
    assert_eq!(m.current().unwrap().unwrap().version, "0.3.0");
}
