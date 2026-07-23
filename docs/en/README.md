# Copy Ninjia Developer Documentation

[简体中文](../README.md) · **English** · [日本語](../ja/README.md)

These multi-page docs are for developers: environment setup, architecture, modification recipes, and operations. The root [`README.en.md`](../../README.en.md) is for users and quick starts, while [`AGENTS.md`](../../AGENTS.md) defines coding style and code-placement conventions. Everything else about how to change the project and why it is designed this way lives here.

## Reading Paths

| What you want to do | Start here |
| :--- | :--- |
| Run the project for the first time | [01 Environment Setup and First Run](01-getting-started.md) |
| Understand the overall design | [02 Architecture Overview](02-architecture.md) → [04 Authoritative Runtime Invariants](04-invariants.md) |
| Find where code belongs | [03 Directory Map and Code Placement](03-directory-map.md) |
| Develop, test, and commit day to day | [05 Development Workflow and Quality Gates](05-dev-workflow.md) |
| Add features, tune parameters, or change behavior | [06 Common Modification Recipes](06-modification-guide.md) |
| Deploy, back up, and troubleshoot | [07 Operations and Troubleshooting](07-operations.md) |

## Page Index

1. [Environment Setup and First Run](01-getting-started.md)—dependencies, `.env`, Telegram-side configuration, and the first launch.
2. [Architecture Overview](02-architecture.md)—the main thread and three Workers, the complete journey of a message, and startup/shutdown order.
3. [Directory Map and Code Placement](03-directory-map.md)—each directory's responsibility, where new code belongs, and compatibility-entry conventions.
4. [Authoritative Runtime Invariants](04-invariants.md)—authoritative constraints across modules and lifecycles; `@see` comments in source code point here.
5. [Development Workflow and Quality Gates](05-dev-workflow.md)—the full `bun run check` chain, test isolation, coverage rules, commits, and releases.
6. [Common Modification Recipes](06-modification-guide.md)—step-by-step guides for adding commands, adjusting parameters, adding AI tools, and changing configuration or persistence schemas.
7. [Operations and Troubleshooting](07-operations.md)—systemd deployment, the data root, backup strategy, and startup troubleshooting.

## Documentation Maintenance

- Chinese originals remain in `docs/`, with English mirrors in `docs/en/` and Japanese mirrors in `docs/ja/`; update corresponding pages together whenever content, links, or behavioral figures change.
- Cross-module constraints have one authoritative home: [04 Authoritative Runtime Invariants](04-invariants.md). Other pages and source comments should link to it rather than restating it.
- The source of truth for behavioral parameters such as probabilities, capacities, and durations is `src/consts/`. Documentation should name constants and file paths instead of copying numeric values where possible; figures that must appear in the root README must be updated whenever those parameters change.
- Test and coverage figures in the root README come from an actual `bun run test:coverage` run. See [05 Development Workflow](05-dev-workflow.md#updating-readme-metrics) for the update procedure.
