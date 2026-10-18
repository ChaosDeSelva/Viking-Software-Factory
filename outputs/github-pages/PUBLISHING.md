# GitHub Pages release preparation

Seven sites are prepared: the factory, Heimdall, Mimir, Sindri, Brokkr, Hulder and Skidbladnir.
Herdr is an upstream integration and has no rebranded site.

Preview from this directory with `python3 -m http.server 8090 --bind 127.0.0.1`.
The four workspace projects have a `site/` directory and a manually triggered
`.github/workflows/pages.yml`. Their READMEs use the supplied banner images.
The Hulder site and workflow are also installed in its existing checkout.

After selecting the final public repositories, configure Settings → Pages →
Source → GitHub Actions. Run the Project Pages workflow. It deploys only `site/`;
it never publishes runtime state, local tokens, screenshots of private work or
source archives. The umbrella workflow example deploys this seven site directory.
No GitHub repositories were created and no sites were published by this script.

The README text files are readable snapshots; links in them remain repository
relative. For release, verify the final repository links and download destinations.
The factory and Hulder site copy are staged, not independent Git repositories.

The artwork was supplied by the maintainer; the site does not assert new rights
over upstream names, logos or code. Preserve each repository's licenses.
