# Publish Skidbladnir on GitHub Pages

The website is built and available locally. It has not been published: no GitHub owner/repository was supplied for this project.

1. Create or select the intended public repository.
2. Put the contents of the `skidbladnir` project directory at that repository's root. Do not upload `.data/`, `node_modules/`, local logs, or credentials.
3. In Settings → Pages, set the source to GitHub Actions.
4. Push the site and `.github/workflows/pages.yml` to `main`, or manually run “Skidbladnir Pages”.
5. Use the URL returned by the deployment job. Do not assume a URL until deployment succeeds.

The workflow uploads only `site/`. All asset links are relative, so the site supports both a repository subpath and a domain root. It needs no build step, backend, AWS account, or secrets. It never connects to the local dashboard.

If this project remains nested in a larger repository, move the workflow into that repository's top level `.github/workflows/` and update the artifact path and path filters to the actual project location.

The workflow follows GitHub's [custom Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages). GitHub Pages hosts the public project website; it cannot host the Node/SQLite local application.

## Artwork

The supplied `site/assets/skidbladnir-banner.png` is now referenced by the README and site. The source image is preserved without pixel modifications. Provenance is recorded in `NOTICE`; the original SVG remains as an unused alternative.
