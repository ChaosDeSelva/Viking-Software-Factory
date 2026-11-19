# Viking Factory 0.3.0 preview

The refreshed coordinated release includes the current factory services, native companion, Hulder and Bifrost for Apple silicon Macs running macOS 13.5 or later.

## What changed

- Work with Heimdall, Sindri, Mimir, Skidbladnir and the docs in the companion's native factory window.
- Create change requests, research documents and PR reviews, and use the shared skills library.
- Attach Markdown and images, select accepted documents as context, and follow plans and runs across the factory.
- Carry accepted project decisions into verified code deliveries.
- Install runtime dependencies with portable paths, the built Brokkr harnesses, and consistent service links for configured ports.

## Download and install

Download [Viking-Factory-Setup-0.3.0-macos-arm64.zip](https://github.com/ChaosDeSelva/Viking-Software-Factory/releases/download/v0.3.0/Viking-Factory-Setup-0.3.0-macos-arm64.zip) and extract it. Move Viking Factory.app to Applications. Open it, choose the optional components, select **Install bundle**, and select `factory-manifest.json` in the extracted `bundle` directory. Run **Health check**, sign into your agent tools, then start the factory.

Existing managed installations can select **Preview** updates, then **Check updates** and **Apply update**. After installation, choose **Open updated companion**. The separate app ZIP contains the companion for users who already have the factory installed. The individual component ZIPs and signed manifest are also available for the updater.

The bundle includes Hulder 0.1.7; component package filenames follow the coordinated 0.3.0 version. The runtime includes official Node 26.5.0, npm and production dependencies. Node requires macOS 13.5 or later. Git and authenticated agent tools remain separate prerequisites. Installation does not create cloud resources.

The companion and Hulder are Developer ID signed and Apple notarized. The manifest uses the existing pinned Ed25519 update key. Data schema remains 1; project data stays separate from installed software.

## Validation and scope

The manager passed 39 Rust tests, 10 packaging tests, 17 launcher checks and four factory adapter checks. Service results are recorded in the five source components' 0.2.0 release notes; Hulder and Bifrost have their own release records. This release is also checked with signed application verification, installation of the packaged runtime, and public download verification. The release assets include checksums and a source record.

This remains a preview. Manual VoiceOver, login registration and installation on a separate clean Mac are not claimed. Prior real-agent and cloud acceptance remains historical evidence; this release does not claim a new authenticated test of every agent provider or cloud configuration.
