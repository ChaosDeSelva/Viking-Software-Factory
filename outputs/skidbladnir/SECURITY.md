# Security

This early build is a loopback only simulator. Do not expose its HTTP server through a public tunnel or reverse proxy. It is not a multi user authentication service.

Mutation requests require a per process session token and the expected origin/host. The browser obtains the token through a same origin endpoint; operating system users with access to the process or files remain inside the local trust boundary.

Data is stored under `.data/` in a private directory. Worker names and history are not secrets, but may describe private projects. Avoid real secrets in names, test data, and screenshots.

No AWS credentials are read by the current implementation. AWS provisioning, remote execution, and independent expiration are not shipped features.

When the public repository is configured, enable GitHub private vulnerability reporting. Use that channel for sensitive reports; do not post exploit details or credentials in public issues. Until a reporting destination exists, keep sensitive details private and contact the maintainer directly.
