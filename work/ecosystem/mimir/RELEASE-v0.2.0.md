# Mimir 0.2.0 preview

Updated source release for the coordinated Viking Factory 0.3.0 preview. The published source and integrated runtime retain the current factory features and compatible component dependencies.

For a prebuilt installation, [download Viking Factory 0.3.0 for Apple silicon](https://github.com/ChaosDeSelva/Viking-Software-Factory/releases/download/v0.3.0/Viking-Factory-Setup-0.3.0-macos-arm64.zip). The setup includes the services, optional components, native companion, and signed update manifest. It requires macOS 13.5 or later.

Includes the refreshed factory runtime and dependencies, with conservative database-lock recovery that preserves live reclaimers and handles malformed process identifiers.

Production build and type checks passed. Component tests recorded 4,953 unique passes and five existing optional skips; four retention checks passed on retry with a 60-second timeout. Final database-lock and refreshed Brokkr-verifier regression checks also passed. See the [coordinated release record](https://github.com/ChaosDeSelva/Viking-Software-Factory/blob/main/RELEASE-v0.3.0.md) for verification results.

This tag is a source preview; internal package versions may differ. Read the repository README for building this component independently. Existing agent tools and authentication remain separate prerequisites. Historical vendor and cloud acceptance is not a claim that every integration was rerun for this release.
