# my-oif-project

Monorepo managed with [moonrepo](https://moonrepo.dev/) for running the OIF solver and related contract workflows on test networks such as Ethereum Sepolia and Base Sepolia.

## Packages

- `packages/my-oif-contracts/` — contract and deployment scripts
- `packages/my-oif-solver/` — Rust solver wrapper, rendered JSON config flow, and TypeScript tooling

See the package-level guide for solver usage:

- [`packages/my-oif-solver/README.md`](packages/my-oif-solver/README.md)

## Requirements

- Moon
- Rust and Cargo
- Node.js and npm
- Redis
- `jq`

Copy and fill each package `.env.example` as needed. Do not commit `.env`.

## Common Tasks

From the monorepo root:

```bash
cd my-oif-project
moon run my-oif-contracts:deploy-one-chain -- eth-sepolia
moon run my-oif-contracts:dry-run -- eth-sepolia
moon run my-oif-contracts:verify-one-chain -- eth-sepolia
```

Additional solver tasks:

```bash
moon run my-oif-solver:npm-install
moon run my-oif-solver:bootstrap
moon run my-oif-solver:start

moon run my-oif-solver:build
moon run my-oif-solver:test
moon run my-oif-solver:clippy
moon run my-oif-solver:fmt-check
```

## Notes

- `my-oif-solver` now renders JSON config placeholders such as `${ALCHEMY_API_KEY}` into a temporary file before running the solver.
- The same wrapper is used for both `bootstrap` and `start`.
- The project-level solver flow uses escrow only. The Compact route is not used by the project CLI or default config.
- If you prefer to work inside the package directory, equivalent `npm run ...` commands are documented in `packages/my-oif-solver/README.md`.
- `my-oif-contracts` deploy tasks are thin Moon wrappers over the scripts in `packages/my-oif-contracts/script/deploy/universal/`.

## References

- Moonrepo docs: [https://moonrepo.dev/docs](https://moonrepo.dev/docs)
- Upstream solver: [openintentsframework/oif-solver](https://github.com/openintentsframework/oif-solver)
