/**
 * The landing FAQ, in one place because it is rendered twice.
 *
 * Once as markup by src/components/Faq.astro, and once as `FAQPage` structured
 * data on the landing page. Two copies would drift, and drifted structured data
 * is worse than none: a search engine can show an answer the page does not
 * contain.
 *
 * These answer ON THE PAGE rather than linking away. The one question somebody
 * has before installing anything ("do I have to get a Slack app approved?")
 * should not cost them a page load, and deep links into docs are fragile
 * besides, since a heading rename breaks a fragment silently.
 *
 * Every answer is taken from docs/. If you change one here, change it there
 * too, or better, do not write anything here the docs do not already say.
 *
 * `a` is plain text with no markup: the schema needs a string, and an answer
 * that renders as one paragraph is an answer somebody can actually read.
 * `more.path` is a site path, joined onto the base by the component.
 */
export const FAQ = [
  {
    q: 'Do I need to create a Slack app to use SlackCLI?',
    a: `No, and that is the point. Run slackcli auth login-auto, sign in to Slack in the
        browser window that opens, and SlackCLI captures the session tokens for every
        workspace on that account. No app to register, no OAuth scopes to justify, no
        admin approval to wait for. If you would rather use a real Slack app token
        (xoxb or xoxp), that works too and is the better choice for CI and service
        accounts.`,
    more: { label: 'Authentication', path: '/docs/user-guide/authentication/' },
  },
  {
    q: 'Is this the official Slack CLI?',
    a: `No. SlackCLI is an unofficial, MIT-licensed project and is not affiliated with,
        endorsed by, or supported by Slack Technologies. Slack ships its own CLI, and it
        is a different tool for a different job: theirs is for building and deploying
        Slack apps, this one is for driving a workspace you already belong to.`,
    more: { label: 'Documentation', path: '/docs/' },
  },
  {
    q: 'Where are my Slack tokens stored, and does anything leave my machine?',
    a: `Credentials live in ~/.config/slackcli/workspaces.json, in a directory created
        with mode 0700 and a file with mode 0600. SlackCLI never prints a token value,
        and it talks to exactly two hosts: Slack, and GitHub for the daily update check,
        which you can ignore. There is no account, no telemetry and no server in the
        middle. Treat that config directory as sensitive, because anything that can read
        it can act as you in Slack.`,
    more: { label: 'Where credentials live', path: '/docs/user-guide/workspaces/#config-file' },
  },
  {
    q: 'Can an AI agent or a shell script drive it?',
    a: `Yes, that is a first-class use case rather than an afterthought. Every command
        that returns data speaks --json, and so do the commands that write: send, edit
        and draft echo back what they just wrote, so a later step can edit or react to
        it. Exit codes are meaningful, so a pipeline can branch on failure. SlackCLI also
        ships a Claude Code plugin whose /slackcli skill lets an agent read, post and
        search a workspace without you writing the commands.`,
    more: { label: 'Scripting and JSON', path: '/docs/user-guide/scripting/' },
  },
  {
    q: 'Can I use several workspaces, or several identities in one workspace?',
    a: `Both. Every workspace you authenticate is stored under its own profile key, the
        first one becomes the default, and every command that talks to Slack accepts
        --workspace <id|name>. That means one machine can hold your own account, a bot
        token for automation, and a second company's workspace side by side, and each
        command picks the one it needs.`,
    more: { label: 'Workspaces and profiles', path: '/docs/user-guide/workspaces/' },
  },
  {
    q: 'What can it actually do?',
    a: `Eleven command groups: list channels and DMs, read history and threads, see what
        is unread, send and reply and edit and react, upload files, post Block Kit,
        search messages and channels and people, read your saved-for-later list, read a
        Canvas as Markdown, inspect and download files, list custom emoji, manage user
        groups, and update itself. Anywhere a command wants a channel ID or a timestamp,
        you can paste a Slack permalink instead.`,
    more: { label: 'Every command', path: '/docs/user-guide/' },
  },
];
