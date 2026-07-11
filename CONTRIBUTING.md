# Contributing

Thanks for your interest in contributing to `openclaw-cursor-cli`!

## Development Setup

```bash
git clone https://github.com/coo-quack/openclaw-cursor-cli.git
cd openclaw-cursor-cli
npm install
```

## Commands

```bash
npm test        # Run tests (node --test)
npm run typecheck # Type check with tsc
npm run lint      # Check with oxlint
npm run check     # typecheck + lint + tests (full CI check)
```

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
- All tests must pass (`npm test`)
- Lint must pass (`npm run lint`)
- One approval required to merge

## Code Style

Enforced by [oxlint](https://oxc.rs/docs/guide/usage/linter.html). Run `npm run lint` before committing.
