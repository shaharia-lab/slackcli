# Nix

The flake at the repository root exposes the CLI as a package and a development
shell. Supported systems are `x86_64-linux`, `aarch64-linux` and
`aarch64-darwin`.

Flakes must be enabled. If they are not, add this to `/etc/nix/nix.conf` or
`~/.config/nix/nix.conf`:

```
experimental-features = nix-command flakes
```

## Run it without installing

```bash
nix run github:shaharia-lab/slackcli -- --help
```

Pin to a release or a commit by appending a git ref:

```bash
nix run github:shaharia-lab/slackcli/v0.7.1 -- --version
```

## Install it

Into your profile:

```bash
nix profile install github:shaharia-lab/slackcli
```

As a flake input, for a NixOS or home-manager configuration:

```nix
{
  inputs.slackcli.url = "github:shaharia-lab/slackcli";

  # then, in your module:
  # environment.systemPackages = [ inputs.slackcli.packages.${pkgs.system}.default ];
  # or with home-manager:
  # home.packages = [ inputs.slackcli.packages.${pkgs.system}.default ];
}
```

The first build pulls `bun2nix` from the `nix-community` cache. The flake
declares that substituter in `nixConfig`, so nix will ask for permission to use
it. Answer yes, or pass `--accept-flake-config`.

## Develop

```bash
nix develop
```

The shell provides bun, pre-commit and bun2nix. The usual workflow applies from
there:

```bash
bun install
pre-commit install
bun run dev --help
bun test
```

## Files

| File | Purpose |
|---|---|
| `flake.nix` | Entry point: inputs, systems, outputs |
| `nix/package.nix` | The package derivation |
| `nix/dev.nix` | The development shell |
| `nix/bun.nix` | Generated dependency set, do not edit by hand |

`nix/package.nix` reads `pname` and `version` out of `package.json`, and the
build phase calls `bun run build`, so compile flags stay in
`scripts/build.ts`. Nothing about the package is restated in nix.

## After changing dependencies

`nix/bun.nix` maps every entry in `bun.lock` to a fetch with the hash the
lockfile already records. It is generated, so regenerate it whenever `bun.lock`
changes:

```bash
nix develop -c bun2nix -o nix/bun.nix
```

CI fails if the committed file does not match `bun.lock`. A stale file also
breaks `nix build`, because the missing dependency sends `bun install` to the
network, which the build sandbox blocks.
