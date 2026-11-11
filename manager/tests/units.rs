//! Library functions that need no services, plus the offline release tool.
mod common;
use base64::Engine;
use common::label as label_for;
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::json;
use std::{fs, io::Write, os::unix::fs::PermissionsExt, process::Command};
use viking_manager::*;
use zip::{write::SimpleFileOptions, ZipWriter};

fn manifest() -> Manifest {
    Manifest {
        schema: 1,
        version: "1.2.3".into(),
        channel: "stable".into(),
        platform: "macos-arm64".into(),
        data_schema: 1,
        packages: vec![Package {
            id: "core".into(),
            version: "1.2.3".into(),
            archive: "core.zip".into(),
            sha256: "a".repeat(64),
            required: true,
        }],
    }
}

#[test]
fn manifests_are_validated_field_by_field() {
    manifest().validate().unwrap();
    let mut preview = manifest();
    preview.channel = "preview".into();
    preview.packages.push(Package {
        id: "hulder".into(),
        required: false,
        archive: "h-1.0.0+b.zip".into(),
        ..manifest().packages[0].clone()
    });
    preview.validate().unwrap();
    type Change = fn(&mut Manifest);
    let cases: Vec<(Change, &str)> = vec![
        (|m| m.schema = 2, "Unsupported manifest or data schema"),
        (|m| m.data_schema = 2, "Unsupported manifest or data schema"),
        (|m| m.version = "1.2".into(), "unexpected end"),
        (|m| m.version = "../1.2.3".into(), "unexpected character"),
        (
            |m| m.platform = "linux-x64".into(),
            "Unsupported platform or channel",
        ),
        (
            |m| m.channel = "nightly".into(),
            "Unsupported platform or channel",
        ),
        (
            |m| m.packages[0].id = "other".into(),
            "Invalid package manifest",
        ),
        (
            |m| m.packages.push(m.packages[0].clone()),
            "Invalid package manifest",
        ),
        (
            |m| m.packages[0].archive = "../core.zip".into(),
            "Invalid package manifest",
        ),
        (
            |m| m.packages[0].archive = "core.tar".into(),
            "Invalid package manifest",
        ),
        (
            |m| m.packages[0].archive = format!("{}.zip", "a".repeat(100)),
            "Invalid package manifest",
        ),
        (
            |m| m.packages[0].archive = "..".into(),
            "Invalid package manifest",
        ),
        (
            |m| m.packages[0].sha256 = "a".repeat(63),
            "Invalid package manifest",
        ),
        (
            |m| m.packages[0].sha256 = "g".repeat(64),
            "Invalid package manifest",
        ),
        (
            |m| m.packages[0].version = "x".into(),
            "unexpected character",
        ),
        (
            |m| m.packages[0].required = false,
            "Required core package missing",
        ),
        (|m| m.packages.clear(), "Required core package missing"),
    ];
    for (change, message) in cases {
        let mut m = manifest();
        change(&mut m);
        let e = m.validate().unwrap_err().to_string();
        assert!(e.contains(message), "{message}: {e}");
    }
    // `required` defaults to false when absent.
    let parsed: Package = serde_json::from_value(
        json!({"id":"core","version":"1.0.0","archive":"c.zip","sha256":"a"}),
    )
    .unwrap();
    assert!(!parsed.required);
}

#[test]
fn files_are_written_privately_and_atomically() {
    let t = tempfile::tempdir().unwrap();
    let p = t.path().join("state.json");
    write_json(&p, &json!({"a":1})).unwrap();
    assert_eq!(
        fs::metadata(&p).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(!t.path().join("state.pending").exists());
    assert_eq!(read_json::<serde_json::Value>(&p).unwrap(), json!({"a":1}));
    atomic(&p, b"not json").unwrap();
    assert!(read_json::<serde_json::Value>(&p).is_err());
    assert!(read_json::<serde_json::Value>(&t.path().join("absent")).is_err());
    assert!(atomic(&t.path().join("missing/dir/file"), b"x").is_err());
    assert!(now() > 1_700_000_000);
}

#[test]
fn signatures_need_a_valid_key_and_signature_encoding() {
    let b = base64::engine::general_purpose::STANDARD;
    let doc = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap();
    let pair = Ed25519KeyPair::from_pkcs8(doc.as_ref()).unwrap();
    let key = b.encode(pair.public_key().as_ref());
    let sig = b.encode(pair.sign(b"m").as_ref());
    verify_signature(b"m", &format!(" {sig}\n"), &format!("{key}\n")).unwrap();
    assert!(verify_signature(b"m", &sig, "not base64!").is_err());
    assert!(verify_signature(b"m", "not base64!", &key).is_err());
    assert!(verify_signature(b"m", &sig, &b.encode([0u8; 31]))
        .unwrap_err()
        .to_string()
        .contains("signature is invalid"));
}

#[test]
fn release_selection_newer_and_doctor_checks() {
    let list = vec![
        json!({"draft":false,"prerelease":false,"tag_name":"v1.10.0"}),
        json!({"draft":false,"prerelease":false,"tag_name":"v1.9.0"}),
        json!({"draft":false,"prerelease":false,"tag_name":"latest"}),
        json!({"draft":false,"prerelease":false}),
        json!({"prerelease":false,"tag_name":"v9.0.0"}),
    ];
    assert_eq!(
        select_release(&list, "stable").unwrap()["tag_name"],
        "v1.10.0"
    );
    assert!(select_release(&[], "preview").is_none());
    let c = json!({"tag_name":"v1.10.0"});
    assert!(newer(Some(&c), Some("1.9.9")));
    assert!(!newer(Some(&c), Some("1.10.0")));
    assert!(!newer(Some(&c), Some("2.0.0")));
    assert!(newer(Some(&c), None));
    assert!(
        newer(Some(&c), Some("garbage")),
        "an unreadable installed version is replaced"
    );
    assert!(!newer(Some(&json!({"tag_name":"bad"})), None));
    assert!(!newer(Some(&json!({})), None));
    assert!(!newer(None, None));
    assert!(check_passed("git", Ok("git version 2".into())));
    assert!(!check_passed("git", Err("missing".into())));
    assert!(check_passed("claude", Ok(r#"{"loggedIn":true}"#.into())));
    for out in [r#"{"loggedIn":false}"#, "{}", "signed in"] {
        assert!(!check_passed("claude", Ok(out.into())), "{out}");
    }
}

fn archive(
    t: &std::path::Path,
    build: impl FnOnce(&mut ZipWriter<fs::File>),
) -> (std::path::PathBuf, String) {
    let path = t.join("a.zip");
    let mut z = ZipWriter::new(fs::File::create(&path).unwrap());
    build(&mut z);
    z.finish().unwrap();
    let sha = hex(&path);
    (path, sha)
}
fn hex(p: &std::path::Path) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(fs::read(p).unwrap()))
}

#[test]
fn extraction_verifies_checksums_and_keeps_entries_and_links_inside() {
    let opts = SimpleFileOptions::default();
    let t = tempfile::tempdir().unwrap();
    let (path, sha) = archive(t.path(), |z| {
        z.add_directory("bin/", opts).unwrap();
        z.start_file("bin/tool", opts.unix_permissions(0o755))
            .unwrap();
        z.write_all(b"#!/bin/sh").unwrap();
        z.start_file("data/note.txt", opts.unix_permissions(0o644))
            .unwrap();
        z.write_all(b"note").unwrap();
        z.add_symlink("links/up", "../data/./note.txt", opts)
            .unwrap();
    });
    let out = t.path().join("out");
    assert!(extract_zip(&path, &out, &"0".repeat(64))
        .unwrap_err()
        .to_string()
        .contains("checksum mismatch"));
    assert!(
        !out.exists(),
        "nothing is written before the checksum matches"
    );
    extract_zip(&path, &out, &sha.to_uppercase()).unwrap();
    assert_eq!(
        fs::metadata(out.join("bin/tool"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(out.join("data/note.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(fs::read(out.join("links/up")).unwrap(), b"note");
    assert!(
        extract_zip(&path, &out, &sha).is_err(),
        "existing files are never overwritten"
    );
    assert!(extract_zip(&t.path().join("absent.zip"), &out, &sha).is_err());
    let not_zip = t.path().join("plain.zip");
    fs::write(&not_zip, "plain").unwrap();
    assert!(extract_zip(&not_zip, &t.path().join("o2"), &hex(&not_zip)).is_err());

    for (i, (name, target, message)) in [
        ("/etc/evil", None, "Unsafe relative path"),
        ("a/../../evil", None, "Unsafe relative path"),
        ("./a", None, "Unsafe relative path"),
        ("", None, "Unsafe relative path"),
        (
            "link",
            Some("/etc/passwd"),
            "Absolute archive link rejected",
        ),
        (
            "deep/link",
            Some("../../outside"),
            "Archive link escapes installation",
        ),
        ("link", Some("missing-target"), "No such file"),
    ]
    .into_iter()
    .enumerate()
    {
        let dir = t.path().join(format!("case{i}"));
        fs::create_dir(&dir).unwrap();
        let (path, sha) = archive(&dir, |z| match target {
            Some(target) => z.add_symlink(name, target, opts).unwrap(),
            None => {
                z.start_file(name, opts).unwrap();
                z.write_all(b"x").unwrap();
            }
        });
        let e = extract_zip(&path, &dir.join("out"), &sha)
            .unwrap_err()
            .to_string();
        assert!(e.contains(message), "{name}: {e}");
    }
    let dir = t.path().join("long");
    fs::create_dir(&dir).unwrap();
    let (path, sha) = archive(&dir, |z| {
        z.add_symlink("l", "a/".repeat(2100), opts).unwrap()
    });
    assert!(extract_zip(&path, &dir.join("out"), &sha)
        .unwrap_err()
        .to_string()
        .contains("too long"));
    // Lexically `hop/far/..` stays inside, but `hop` and `far` are links whose chain ends outside.
    let dir = t.path().join("chain");
    fs::create_dir(&dir).unwrap();
    let (path, sha) = archive(&dir, |z| {
        z.add_symlink("hop", "sub", opts).unwrap();
        z.add_directory("sub/", opts).unwrap();
        z.add_symlink("sub/far", "..", opts).unwrap();
        z.add_symlink("escape", "hop/far/..", opts).unwrap();
    });
    let e = extract_zip(&path, &dir.join("out"), &sha)
        .unwrap_err()
        .to_string();
    assert!(e.contains("resolves outside installation"), "{e}");
}

#[test]
fn opening_a_root_refuses_foreign_directories_and_concurrent_managers() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().join("m");
    let m = Manager::open(root.clone()).unwrap();
    for d in ["releases", "downloads", "data", "logs", "backups"] {
        assert!(m.root.join(d).is_dir());
    }
    assert_eq!(
        fs::metadata(&m.root).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert!(Manager::open(root.clone())
        .err()
        .unwrap()
        .to_string()
        .contains("Another manager"));
    assert!(m.current().unwrap().is_none());
    assert!(m
        .release()
        .unwrap_err()
        .to_string()
        .contains("Nothing installed"));
    let receipt =
        json!({"version":"../escape","data_schema":1,"components":["core"],"installed_at":0});
    write_json(&m.root.join("current.json"), &receipt).unwrap();
    assert!(m
        .release()
        .unwrap_err()
        .to_string()
        .contains("Invalid installation receipt"));
    fs::write(m.root.join("current.json"), "{").unwrap();
    assert!(m.current().is_err());
    let label = m.label("core");
    assert!(label.starts_with("dev.viking.factory.") && label.ends_with(".core"));
    assert_ne!(
        label,
        Manager::open(t.path().join("other")).unwrap().label("core"),
        "labels differ per root"
    );
    assert_eq!(label, label_for(&m.root, "core"));
    let cfg = m.config().unwrap();
    assert_eq!(
        (
            cfg.channel.as_str(),
            cfg.mimir_port,
            cfg.sindri_port,
            cfg.heimdall_port,
            cfg.skidbladnir_port
        ),
        ("preview", 7700, 4310, 4320, 4380)
    );
    drop(m);
    // A dropped manager releases its lock.
    Manager::open(root).unwrap();
}

fn release_tool(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_viking-release"))
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn the_release_tool_generates_signs_and_verifies() {
    let t = tempfile::tempdir().unwrap();
    let key = t.path().join("signing.key");
    let generated = release_tool(&["keygen", key.to_str().unwrap()]);
    assert!(generated.status.success());
    assert_eq!(
        fs::metadata(&key).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let public = t.path().join("public.txt");
    fs::write(&public, &generated.stdout).unwrap();
    let again = release_tool(&["keygen", key.to_str().unwrap()]);
    assert_eq!(again.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&again.stderr).contains("Refusing to overwrite"));

    let m = t.path().join("factory-manifest.json");
    write_json(&m, &manifest()).unwrap();
    let signed = release_tool(&["sign", key.to_str().unwrap(), m.to_str().unwrap()]);
    assert!(
        signed.status.success(),
        "{}",
        String::from_utf8_lossy(&signed.stderr)
    );
    assert!(t.path().join("factory-manifest.sig").exists());
    assert!(
        release_tool(&["verify", public.to_str().unwrap(), m.to_str().unwrap()])
            .status
            .success()
    );
    let mut changed = manifest();
    changed.version = "9.9.9".into();
    write_json(&m, &changed).unwrap();
    let refused = release_tool(&["verify", public.to_str().unwrap(), m.to_str().unwrap()]);
    assert_eq!(refused.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&refused.stderr).contains("signature is invalid"));

    let mut invalid = manifest();
    invalid.platform = "linux".into();
    write_json(&m, &invalid).unwrap();
    assert!(String::from_utf8_lossy(
        &release_tool(&["sign", key.to_str().unwrap(), m.to_str().unwrap()]).stderr
    )
    .contains("Unsupported platform"));
    fs::write(&key, "not a key").unwrap();
    assert!(String::from_utf8_lossy(
        &release_tool(&["sign", key.to_str().unwrap(), m.to_str().unwrap()]).stderr
    )
    .contains("Invalid signing key"));
    for (args, message) in [
        (vec![], "Use keygen, sign or verify"),
        (vec!["keygen"], "keygen <private key path"),
        (vec!["sign"], "sign <key path>"),
        (vec!["sign", key.to_str().unwrap()], "Invalid signing key"),
        (vec!["verify"], "verify <public key file>"),
        (vec!["verify", public.to_str().unwrap()], "Provide manifest"),
    ] {
        let o = release_tool(&args);
        assert_eq!(o.status.code(), Some(1), "{args:?}");
        assert!(
            String::from_utf8_lossy(&o.stderr).contains(message),
            "{args:?}: {}",
            String::from_utf8_lossy(&o.stderr)
        );
    }
}
