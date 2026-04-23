# my-oif-project

Monorepo managed with [moonrepo](https://moonrepo.dev/) for running the OIF solver and related contract workflows on Ethereum Sepolia and Base Sepolia.

## Packages

| Package                                                             | Purpose                                                                                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [`packages/my-oif-contracts/`](packages/my-oif-contracts/README.md) | Foundry contract suite and CREATE2 deployment scripts for OIF input/output settlers and Hyperlane oracles                            |
| [`packages/my-oif-solver/`](packages/my-oif-solver/README.md)       | Rust OIF solver binary wrapper, JSON config rendering, and TypeScript CLI for quotes, `open`, `openFor`, refunds, and order tracking |

## Moon Tasks (no `.env` required)

These tasks work without any `.env` configuration and are useful for CI or a fresh clone.

### `my-oif-contracts` — Contract build and tests (requires Foundry)

```bash
moon run my-oif-contracts:build      # forge build
moon run my-oif-contracts:test       # forge test
```

### `my-oif-solver` — Build and quality checks (requires Rust)

```bash
moon run my-oif-solver:npm-install   # install Node.js dependencies
moon run my-oif-solver:build         # compile the Rust solver binary
moon run my-oif-solver:test          # run Rust unit tests
moon run my-oif-solver:clippy        # Rust lint (Clippy)
moon run my-oif-solver:fmt-check     # check Rust formatting
```

## Notes

- Tasks that require secrets (solver start, bootstrap, contract deploy, verify) are documented in each package's own README.
- `my-oif-solver` renders JSON config placeholders such as `${ALCHEMY_API_KEY}` into a temporary file before starting the solver binary.
- The project uses the **escrow** settlement path only; the Compact route is not used by this project's config or CLI.

## References

- Moonrepo docs: [moonrepo.dev/docs](https://moonrepo.dev/docs)
- Upstream solver: [openintentsframework/oif-solver](https://github.com/openintentsframework/oif-solver)
