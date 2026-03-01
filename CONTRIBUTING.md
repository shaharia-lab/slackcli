# Contributing to SlackCLI

Thank you for your interest in contributing to SlackCLI! We welcome contributions from everyone — whether you are a human developer or an AI agent.

Regardless of the source, all contributions go through the same review process and must meet the same quality standards. We maintain strict coding standards, automated checks, and thorough reviews to keep the codebase clean, reliable, and maintainable.

## Ways to Contribute

- **Report bugs** — Open a GitHub issue describing the problem, steps to reproduce, and expected behavior.
- **Request features** — Open a GitHub issue describing the feature, the motivation behind it, and any ideas for implementation.
- **Propose ideas** — Start a discussion via a GitHub issue to gather community feedback before diving into code.
- **Submit pull requests** — Fix bugs, implement features, improve documentation, or refactor code.

## Issues Before Pull Requests

**Every pull request must be linked to a GitHub issue.**

Opening an issue first gives the community the opportunity to discuss the problem or feature, provide feedback on the approach, and ensure visibility into the work being planned. Pull requests created without a corresponding issue may be closed.

1. Search existing issues to avoid duplicates.
2. Open a new issue if none exists.
3. Wait for acknowledgment or feedback before starting significant work.
4. Reference the issue in your pull request (e.g., `Fixes #42` or `Closes #42`).

## Development Setup

### Prerequisites

- [Bun](https://bun.sh/) v1.0+

### Install Dependencies

```bash
bun install
```

### Running the CLI

```bash
bun run dev --help
```

### Running Tests

```bash
bun test                                        # Run all tests
bun test src/lib/curl-parser.test.ts            # Run a single test file
bun run type-check                              # TypeScript type checking
```

### Building

```bash
bun run build        # Build binary for current platform
bun run build:all    # Build for all platforms
```

## Pull Request Guidelines

### Before Submitting

- [ ] Your PR is linked to a GitHub issue.
- [ ] All tests pass (`bun test`).
- [ ] Type checking passes (`bun run type-check`).
- [ ] You have checked whether your changes require a documentation update — if so, include the documentation changes in the same PR.

### Code Quality Standards

- Write clean, readable code that follows existing patterns in the codebase.
- Keep changes focused — one issue per pull request.
- Add tests for new functionality and bug fixes.
- Avoid over-engineering — solve the problem at hand without unnecessary abstractions.
- Respect the existing architecture and dual-auth design (see `CLAUDE.md` for details).

### Documentation

Check whether your changes require documentation updates. This includes:

- New commands or options
- Changes to authentication flows
- Changes to the development setup or build process
- Architecture changes

Include documentation updates in the same pull request as the code changes.

### Commit Messages

Write clear, descriptive commit messages. Use the imperative mood (e.g., "Add pagination to list endpoints" not "Added pagination").

## For AI Agent Contributors

AI-generated contributions are welcome and go through the same process as human contributions:

1. An issue must exist before a pull request is created.
2. All automated checks (type checking, tests) must pass.
3. Code must meet the same quality and security standards.
4. Pull requests are reviewed with the same rigor.

The `CLAUDE.md` file at the root of the repository contains project-specific instructions, architecture details, and conventions that AI agents should follow when contributing.

## License

By contributing to SlackCLI, you agree that your contributions will be licensed under the [MIT License](LICENSE).
