# Security

This early build is a loopback only simulator. Do not expose its HTTP server through a public tunnel or reverse proxy. It is not a multi user authentication service.

Mutation requests require a per process session token and the expected origin/host. The browser obtains the token through a same origin endpoint that refuses other origins, other local ports (`Sec-Fetch-Site: same-site`) and any `Host` other than the loopback address, so web pages cannot read it. The endpoint does not authenticate local software: any process or operating system user on this machine that can connect to the loopback port can obtain the token and act as the dashboard. All of them remain inside the local trust boundary.

Data is stored under `.data/` in a private directory. Worker names and history are not secrets, but may describe private projects. Avoid real secrets in names, test data, and screenshots.

Simulation is the default and reads no AWS credentials. When `SKIDBLADNIR_AWS_CONFIG` is set, the server uses the configured AWS profile for provisioning, SSM commands, terminals and artifact collection; see `docs/AWS.md`. Credentials stay in that profile and are never sent to the browser.

When the public repository is configured, enable GitHub private vulnerability reporting. Use that channel for sensitive reports; do not post exploit details or credentials in public issues. Until a reporting destination exists, keep sensitive details private and contact the maintainer directly.
