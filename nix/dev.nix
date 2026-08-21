{
  mkShell,
  bun,
  bun2nix,
  pre-commit,
}:
mkShell {
  packages = [
    bun
    bun2nix
    pre-commit
  ];
}
