# Contributing

Thanks for your interest in contributing to `openclaw-cursor-cli`!

## Development Setup

```bash
git clone https://github.com/coo-quack/openclaw-cursor-cli.git
cd openclaw-cursor-cli
corepack enable pnpm   # provisions the version `packageManager` pins
pnpm install
```

The install brings in `openclaw` even though it is only an optional peer
dependency — pnpm resolves those regardless of configuration — so nothing has
to be linked by hand for `tsc` and the unit tests to find
`openclaw/plugin-sdk/*`.

Run `corepack enable pnpm` rather than whatever `pnpm` happens to be on your
PATH. This repo's `pnpm-workspace.yaml` carries settings rather than a package
list — the file explains which and why — and pnpm 10 rejects that shape with
`ERROR packages field missing or empty`. The pinned 11.17.0 accepts it.

### Node version

**Node 22.22.3 or newer** (`engines.node` in `package.json`), matching the
gateway's own floor — `openclaw` declares
`>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`, and `pnpm test` needs that package
installed because `test/index.test.ts` loads the plugin entry, which imports
`openclaw/plugin-sdk/*`.

Older Node fails in two separate ways, both worth knowing if you hit them:

- This package ships TypeScript sources rather than compiled JavaScript, so
  Node has to strip types itself, which it does without a command-line flag
  only from 22.18.0 onwards. Below that, `pnpm test` dies before running a
  single test with `ERR_UNKNOWN_FILE_EXTENSION`.
- Passing `--experimental-strip-types` rescues 22.16.x and 22.17.x but not
  22.6.x, whose type stripping can't parse TypeScript-only syntax such as the
  definite assignment assertion (`let value!: T`) in
  `test/cursor-agent-wrapper.test.ts`.

## Commands

```bash
pnpm test          # Run tests (node --test)
pnpm run typecheck # Type check with tsc
pnpm run lint      # Check with Biome
pnpm run check     # typecheck + lint + tests (full CI check)
```

### Integration tests

`test/integration/` drives a real `openclaw` against this checkout: the plugin
is loaded from a path, a gateway is started, and a turn is routed through both
backends. It is not part of `pnpm run check` — it needs binaries a plain clone
does not have.

```bash
pnpm run test:integration:docker  # build the image and run the suite in it
pnpm run test:integration         # run against the openclaw already on PATH
```

Prefer the Docker form. It is what CI runs, so a failure reproduces, and it
keeps `openclaw` and `cursor-agent` out of the host. Both are installed on
container start rather than baked into a layer, which costs about 15 seconds
and is what makes the suite an early warning for upstream changes.

Everything is scoped to a temp `OPENCLAW_STATE_DIR` and a workspace inside it;
nothing reads or writes `~/.openclaw`. Two tests need the real `cursor-agent`
and assert only that its own authentication error comes back — they skip
themselves wherever credentials exist, so they never spend Cursor quota.

Run the container as a non-root user. As root, `chmod 000` has no effect and
the permission-denied assertions in the unit suite fail; the image already
does the right thing, so this only matters if you override the entrypoint.

## Branching Strategy

```
main
 ├── develop          ← integration branch
 │    └── feature/*  ← new features and non-urgent fixes
 └── hotfix/*        ← urgent production fixes
```

### Normal development

```
feature/your-feature  →  develop  →  main (release)
```

1. Branch from `develop`: `git checkout -b feature/your-feature develop`
2. Open a PR targeting `develop`
3. After review and approval, merge into `develop`
4. When ready to release, open a PR from `develop` → `main`

### Hotfix

For urgent fixes that must go directly to production:

1. Branch from `main`: `git checkout -b hotfix/fix-description main`
2. Apply the fix and open a PR targeting `main`
3. After review and approval, merge into `main`
4. A backport PR to `develop` is created automatically by CI

If the backport PR has conflicts, resolve them manually before merging.

## Release Checklist

When bumping a version, open a PR from `develop` → `main` with:

1. Update `version` in `package.json`
2. Review `README.md` — update model/backend behavior notes if needed

After merging into `main`, `release.yml` automatically creates a git tag
and a GitHub Release.

## Pull Requests

- Follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `hotfix:`, etc.)
- All tests must pass (`pnpm test`)
- Lint must pass (`pnpm run lint`)
- One approval required to merge

## Code Style

Enforced by [Biome](https://biomejs.dev). Run `pnpm run lint` to check and `pnpm run fix` to auto-format before committing.
