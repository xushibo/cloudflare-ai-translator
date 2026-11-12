# Release verification

Validated on 2026-11-12 with Node.js 24.14.1, Wrangler 4.160.1,
Miniflare 5.20261110.1-beta and compatibility date 2026-11-12.

- Installation using the lockfile and official npm registry: passed.
- Generated Worker binding types: passed; generated output is ignored by Git.
- TypeScript check: passed.
- Automated tests: 44 passed, including workerd/D1 integration, configurable
  route prefixes, local HTTP, public HTTPS redirects, quota and concurrency cases.
- Deployment dry-run: passed, 23.18 KiB upload / 7.90 KiB gzip.
- Full npm audit against the official registry: 0 reported vulnerabilities.
- Reviewed the allowlisted source and staged file list for credentials, personal
  account/database IDs, domains and local paths: no matching private values found.
- Fresh Git history contains only this standalone project, no parent workspace history.

Tests use mocked analytics and AI responses; no real translation, remote D1 migration,
production deployment or production credential rotation was performed for this release.
These checks establish local build/test readiness, not a guarantee that every account
has enabled the required Cloudflare products. CI also checks Linux after publication.
