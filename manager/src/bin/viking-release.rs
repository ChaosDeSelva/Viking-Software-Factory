//! Offline maintainer tooling. Never writes private keys into release directories.
use base64::Engine;
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use std::{env, fs, path::Path};
use viking_manager::{atomic, Result};
fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1)
    }
}
fn run() -> Result<()> {
    let a: Vec<_> = env::args().skip(1).collect();
    let b = base64::engine::general_purpose::STANDARD;
    match a.first().map(String::as_str) {
        Some("keygen") => {
            let path = Path::new(
                a.get(1)
                    .ok_or("keygen <private key path outside repository>")?,
            );
            if path.exists() {
                return Err("Refusing to overwrite an existing signing key".into());
            }
            let doc = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
                .map_err(|_| "Key generation failed")?;
            let pair =
                Ed25519KeyPair::from_pkcs8(doc.as_ref()).map_err(|_| "Invalid generated key")?;
            atomic(path, doc.as_ref())?;
            println!("{}", b.encode(pair.public_key().as_ref()));
        }
        Some("sign") => {
            let key = fs::read(a.get(1).ok_or("sign <key path> <manifest path>")?)?;
            let pair = Ed25519KeyPair::from_pkcs8(&key).map_err(|_| "Invalid signing key")?;
            let manifest = Path::new(a.get(2).ok_or("Provide manifest")?);
            let bytes = fs::read(manifest)?;
            let parsed: viking_manager::Manifest = serde_json::from_slice(&bytes)?;
            parsed.validate()?;
            atomic(
                &manifest.with_extension("sig"),
                b.encode(pair.sign(&bytes).as_ref()).as_bytes(),
            )?;
            println!("Signed {}", manifest.display());
        }
        Some("verify") => {
            let public =
                fs::read_to_string(a.get(1).ok_or("verify <public key file> <manifest path>")?)?;
            let manifest = Path::new(a.get(2).ok_or("Provide manifest")?);
            let bytes = fs::read(manifest)?;
            let signature = fs::read_to_string(manifest.with_extension("sig"))?;
            viking_manager::verify_signature(&bytes, signature.trim(), public.trim())?;
            let parsed: viking_manager::Manifest = serde_json::from_slice(&bytes)?;
            parsed.validate()?;
            println!("Manifest signature verified");
        }
        _ => return Err("Use keygen, sign or verify".into()),
    }
    Ok(())
}
