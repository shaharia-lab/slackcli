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
  detects a Homebrew path and points you there so it does not fight the package
  manager.
- **Running from source** (`bun run dev`). There is no binary to replace — use
  `git pull`.

SlackCLI also checks for new releases in the background at most once every 24
hours and prints a one-line notice after your command's output when a newer
version exists. The result is cached in `~/.config/slackcli/update-check.json`.

## Uninstalling

```bash
brew uninstall slackcli          # Homebrew
rm ~/.local/bin/slackcli         # manual install

slackcli auth logout             # remove stored credentials first
rm -rf ~/.config/slackcli        # or wipe the config directory entirely
```
