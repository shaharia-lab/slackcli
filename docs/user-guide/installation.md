# Install SlackCLI on macOS, Linux and Windows

SlackCLI ships as a single self-contained binary. There is no runtime to install
— you do not need Bun or Node.js to *run* it.

## Homebrew (macOS and Linux)

```bash
brew tap shaharia-lab/tap
brew install slackcli
```

Upgrade with `brew upgrade slackcli`.

## Pre-built binaries

Download the binary for your platform, make it executable, and put it on your
`PATH`.

```bash
# Linux x86_64
curl -L https://github.com/shaharia-lab/slackcli/releases/latest/download/slackcli-linux -o slackcli

# Linux arm64
curl -L https://github.com/shaharia-lab/slackcli/releases/latest/download/slackcli-linux-arm64 -o slackcli

# macOS Intel
curl -L https://github.com/shaharia-lab/slackcli/releases/latest/download/slackcli-macos -o slackcli

# macOS Apple Silicon
curl -L https://github.com/shaharia-lab/slackcli/releases/latest/download/slackcli-macos-arm64 -o slackcli

chmod +x slackcli
mkdir -p ~/.local/bin && mv slackcli ~/.local/bin/
```

On Windows, download `slackcli-windows.exe` from the
[latest release](https://github.com/shaharia-lab/slackcli/releases/latest) and
add it to your `PATH`.

Every release publishes a `checksums.txt` alongside the binaries if you want to
verify a manual download.

## From source

Requires [Bun](https://bun.sh) 1.0 or newer.

```bash
git clone https://github.com/shaharia-lab/slackcli.git
cd slackcli
bun install
bun run build          # produces ./dist/slackcli
```

See [development setup](../development/setup.md) for the full contributor
toolchain.

## Verifying the install

```bash
slackcli --version
slackcli --help
```

## Updating

```bash
slackcli update check   # report the latest release without changing anything
slackcli update         # download and replace the running binary in place
```

`slackcli update` downloads the release asset for your platform, verifies its
SHA-256 digest against the digest GitHub publishes for that asset, and only then
replaces the binary. A missing or mismatched digest aborts the update rather
than installing an unverified file.

Two cases where `slackcli update` deliberately does nothing:

- **Installed via Homebrew.** Use `brew upgrade slackcli`; the self-updater
  detects a Homebrew path, prints that hint and exits without downloading or
  touching the binary, so it does not fight the package manager.
- **Running from source** (`bun run dev`). There is no binary to replace — use
  `git pull`.

If the binary sits in a folder you cannot write to, such as `/usr/local/bin`,
`slackcli update` stops before downloading anything and tells you to run
`sudo slackcli update` instead (on Windows: run `slackcli update` from an
Administrator terminal). The update notice and `update check` suggest the same
command. slackcli never elevates itself. Installing to `~/.local/bin` avoids the
need for `sudo` altogether.

SlackCLI also checks for new releases in the background at most once every 24
hours and prints a one-line notice after your command's output when a newer
version exists. The result is cached in `~/.config/slackcli/update-check.json`.
The notice is never shown during `slackcli update` or `slackcli update check`,
and a successful `slackcli update` refreshes the cache with the version it just
installed.

The background check never holds up your command: it gives GitHub 1.5 seconds
to answer and then gives up quietly, and after a failed check (offline, proxy,
rate limit) it waits an hour before trying again instead of retrying on every
command. When a check does finish, the notice at the end of that same run
already shows the version it found. `slackcli update` and `update check`, which
you run on purpose, wait up to 10 seconds for GitHub.

To turn the background check off, set `SLACKCLI_NO_UPDATE_NOTIFIER=1` (any value
other than empty, `0` or `false`). SlackCLI then reads no cache, sends no request
to GitHub and prints no notice. The same happens automatically when the `CI`
environment variable is set to a value other than empty, `0` or `false`, as GitHub
Actions, GitLab CI and most CI systems do. If you set `CI` yourself outside a CI
job, you will stop seeing the notice too. `slackcli update check` and
`slackcli update` are explicit requests and work the same either way.

## Uninstalling

```bash
brew uninstall slackcli          # Homebrew
rm ~/.local/bin/slackcli         # manual install

slackcli auth logout             # remove stored credentials first
rm -rf ~/.config/slackcli        # or wipe the config directory entirely
```
