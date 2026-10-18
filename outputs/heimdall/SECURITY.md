# Security

Heimdall is a single operator loopback application. Authentication, origin/host checks, CSRF protection, operator unlock and source approval gates protect normal browser access. They do not isolate hostile processes running as the same OS user.

Do not expose the listener publicly or commit credentials. Agent execution belongs to Mimir, whose configured hosts and agent permissions must be trusted. SSH connections verify host keys and do not forward the controller's SSH agent.

For a suspected vulnerability, contact the repository maintainer privately through the hosting provider's private vulnerability reporting mechanism when enabled. Until a public repository and private reporting channel exist, do not post credentials, exploit payloads, or private task data in public issues. Public release preparation is not a security certification.
