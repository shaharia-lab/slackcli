{
  description = "A fast, developer-friendly CLI tool for interacting with Slack workspaces";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
    systems.url = "github:nix-systems/triplet";
    bun2nix.url = "github:nix-community/bun2nix?ref=2.1.2";
    bun2nix.inputs.nixpkgs.follows = "nixpkgs";
    bun2nix.inputs.systems.follows = "systems";
  };

  nixConfig = {
    extra-substituters = [ "https://nix-community.cachix.org" ];
    extra-trusted-public-keys = [
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
    ];
  };

  outputs =
    {
      nixpkgs,
      systems,
      bun2nix,
      ...
    }:
    let
      inherit (nixpkgs) lib;
      packageJson = lib.importJSON ./package.json;
      eachSystem =
        build:
        lib.genAttrs (import systems) (
          system:
          build (
            import nixpkgs {
              inherit system;
              overlays = [ bun2nix.overlays.default ];
            }
          )
        );
    in
    {
      packages = eachSystem (pkgs: {
        default = pkgs.stdenv.mkDerivation {
          pname = packageJson.name;
          inherit (packageJson) version;

          src = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [
              ./bun.lock
              ./package.json
              ./tsconfig.json
              ./scripts
              ./src
            ];
          };

          nativeBuildInputs = [ pkgs.bun2nix.hook ];
          bunDeps = pkgs.bun2nix.fetchBunDeps { bunNix = ./bun.nix; };

          buildPhase = "bun run build";
          installPhase = "install -Dm755 dist/${packageJson.name} $out/bin/${packageJson.name}";
          dontFixup = true;
        };
      });

      devShells = eachSystem (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.bun
            pkgs.bun2nix
            pkgs.pre-commit
          ];
        };
      });
    };
}
