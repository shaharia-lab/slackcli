/**
 * Which files in docs/ become pages, in what order, under what heading.
 *
 * Imported by both the sync script and astro.config.mjs, so the sidebar and
 * the generated pages cannot disagree about what exists. A doc added to docs/
 * and not listed here fails the build rather than silently never publishing.
 *
 * `file` is the path RELATIVE TO docs/, including its directory, because this
 * project's docs are nested (`user-guide/`, `development/`) rather than flat.
 * `slug` mirrors that path with the extension dropped and a directory's
 * `README.md` collapsing to the directory itself - so `user-guide/search.md`
 * publishes at `/docs/user-guide/search/` and `user-guide/README.md` at
 * `/docs/user-guide/`. Keeping the two shapes in step is what lets
 * sync-docs.mjs resolve a relative link between two docs without a lookup
 * table of exceptions.
 *
 * `description` overrides the derived <meta> description, and is needed
 * wherever a page opens with something that does not read as a sentence - a
 * code fence, a table, a bullet list, or a heading. See sync-docs.mjs for how
 * the derived one is found.
 */
export const GROUPS = [
  { id: 'users', label: 'User guide' },
  { id: 'contributors', label: 'For contributors' },
];

export const PAGES = [
  {
    file: 'README.md',
    slug: 'index',
    label: 'Overview',
    group: null,
    description:
      'Documentation for SlackCLI - installing it, signing in, every command group, scripting it from a shell or an AI agent, and working on the project itself.',
  },

  // --- User guide, in the order docs/user-guide/README.md itself lists them --
  {
    file: 'user-guide/README.md',
    slug: 'user-guide',
    label: 'Overview',
    group: 'users',
    description:
      'Install SlackCLI, sign in once, and start reading and posting to Slack from your terminal - plus the two options that apply to every command.',
  },
  { file: 'user-guide/installation.md', slug: 'user-guide/installation', label: 'Installation', group: 'users' },
  { file: 'user-guide/authentication.md', slug: 'user-guide/authentication', label: 'Authentication', group: 'users' },
  { file: 'user-guide/workspaces.md', slug: 'user-guide/workspaces', label: 'Workspaces and profiles', group: 'users' },
  { file: 'user-guide/links-and-timestamps.md', slug: 'user-guide/links-and-timestamps', label: 'Links and timestamps', group: 'users' },
  { file: 'user-guide/conversations.md', slug: 'user-guide/conversations', label: 'Conversations', group: 'users' },
  { file: 'user-guide/messages.md', slug: 'user-guide/messages', label: 'Messages', group: 'users' },
  { file: 'user-guide/search.md', slug: 'user-guide/search', label: 'Search', group: 'users' },
  { file: 'user-guide/team.md', slug: 'user-guide/team', label: 'Team', group: 'users' },
  { file: 'user-guide/usergroups.md', slug: 'user-guide/usergroups', label: 'User groups', group: 'users' },
  { file: 'user-guide/saved.md', slug: 'user-guide/saved', label: 'Saved items', group: 'users' },
  { file: 'user-guide/canvas.md', slug: 'user-guide/canvas', label: 'Canvas', group: 'users' },
  { file: 'user-guide/files.md', slug: 'user-guide/files', label: 'Files', group: 'users' },
  { file: 'user-guide/emoji.md', slug: 'user-guide/emoji', label: 'Emoji', group: 'users' },
  { file: 'user-guide/scripting.md', slug: 'user-guide/scripting', label: 'Scripting and JSON', group: 'users' },
  {
    file: 'user-guide/claude-code-plugin.md',
    slug: 'user-guide/claude-code-plugin',
    label: 'Claude Code plugin',
    group: 'users',
    description:
      'Install the slackcli plugin in Claude Code and give the agent a skill that reads, searches and replies in Slack from the terminal.',
  },
  {
    file: 'user-guide/troubleshooting.md',
    slug: 'user-guide/troubleshooting',
    label: 'Troubleshooting',
    group: 'users',
    description:
      'The errors SlackCLI actually prints, and what each one means - authentication failures, missing scopes, browser detection, truncated JSON, rate limits.',
  },

  // --- For contributors, in the order docs/README.md lists them -------------
  {
    file: 'development/README.md',
    slug: 'development',
    label: 'Overview',
    group: 'contributors',
    description:
      'How to work on SlackCLI: the toolchain, the everyday loop, where each part of the codebase lives, and the policy every pull request has to satisfy.',
  },
  {
    file: 'development/setup.md',
    slug: 'development/setup',
    label: 'Development setup',
    group: 'contributors',
    description:
      'The contributor toolchain - Bun, pre-commit hooks, signed commits - and the everyday run, test and type-check loop.',
  },
  { file: 'development/architecture.md', slug: 'development/architecture', label: 'Architecture', group: 'contributors' },
  {
    file: 'development/project-structure.md',
    slug: 'development/project-structure',
    label: 'Project structure',
    group: 'contributors',
    description:
      'What every file under src/ is responsible for - the command groups, the Slack client seam, the auth and storage libraries, and the shared types.',
  },
  { file: 'development/testing.md', slug: 'development/testing', label: 'Testing', group: 'contributors' },
  {
    file: 'development/build-and-release.md',
    slug: 'development/build-and-release',
    label: 'Build and release',
    group: 'contributors',
    description:
      'Compiling the single-file binary, how the version is injected at build time, what CI checks, and the tag that publishes a release and updates the Homebrew tap.',
  },
  { file: 'development/adding-a-command.md', slug: 'development/adding-a-command', label: 'Adding a command', group: 'contributors' },
  {
    file: 'development/website.md',
    slug: 'development/website',
    label: 'Website',
    group: 'contributors',
    description:
      'How this site is built and published: running it locally, adding a documentation page, writing a blog post, and what CI checks.',
  },
];
