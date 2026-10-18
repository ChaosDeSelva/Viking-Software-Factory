# Hulder identity and release cleanup — October 15, 2026

## Implemented

- Runtime app IDs now match Hulder bundle metadata across release channels; macOS instance locks use Hulder names. Existing Hulder user settings/data paths remain isolated. Removed registration as a handler for the upstream `zed:` URL scheme.
- All channels disable upstream update polling. The inactive inherited cloud-server default points to a reserved invalid domain. The shared editor HTTP-denial policy remains intact.
- Help opens a bundled Hulder guide, welcome text and icon are independent, and the welcome button opens the guide instead of upstream onboarding. Existing Hulder app artwork was inspected and retained. Site introduction and README now lead with Hulder, retaining clear attribution.
- Removed inherited GitHub automation for upstream releases, deployment, issue management and notifications. Only manually triggered Pages remains. Previous workflow files and the packaging script were backed up outside the repository.
- Replaced the upstream Mac bundler with a local packaging command that does not download or publish. Added an explicit Developer ID signing script and notarization instructions, using the operator's identity rather than upstream credentials.
- Veil uses Eye when visible and EyeOff when locked, with matching action tooltips and accessible labels. Passkey enforcement is unchanged. Factory task rows now have accessible labels.
- Preserved upstream licenses, copyright notices and internal compatibility identifiers. The working tree identity audit found no employer branding matches. This is not a promise that Git history or every inherited source string contains no upstream names.

## Validation

- Pinned-toolchain Hulder debug build passed. Existing large debug unwind-table and upstream `block` future-compatibility warnings remain.
- Six native network-log/HTTP-denial tests passed.
- Two release-channel tests passed, including identity isolation and disabled upstream polling for every channel.
- Three native Factory-client tests passed; a separate real loopback Mimir acceptance run read a snapshot and task brief/acceptance criteria successfully.
- Local app packaging and `codesign --verify --deep --strict` passed with an ad-hoc development signature.
- Live app exposed the Hulder Help menu, local guide command, Factory task inspector, updated welcome-guide button and Veil accessibility label. A scratch document was typed and saved, and its bytes verified on disk. Native UI automation had intermittent timeouts; these checks are not an exhaustive visual or IDE regression suite.
- Shell syntax, packaging help and `git diff --check` passed.
- Source export includes 4,452 files, local changes, notices and build/release instructions; excludes Git history, local assistant/project configuration, generated binaries and unlisted untracked files. Basic secret-filename/private-key screening passed; it is not a complete security audit.

## Deliverables and remaining release gates

The launcher now targets the refreshed `Hulder Dev.app`. The source archive is a release candidate, not a published release. The native patch includes the integration additions and this cleanup; the complete source archive is the preferred source deliverable.

No valid code-signing identities were visible to `security find-identity` in this environment. Public Developer ID signing, Apple notarization, clean-Mac installation, broad IDE regression testing and public GitHub publication remain pending. Unsupported inherited Windows/Linux packaging is not presented as ready. Upstream documentation links and internal crate/action/project-format identifiers remain for compatibility and attribution.
