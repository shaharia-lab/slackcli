{
  description = "A fast, developer-friendly CLI tool for interacting with Slack workspaces";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
    systems.url = "github:nix-systems/default";
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
      eachSystem =
        build:
        nixpkgs.lib.genAttrs (import systems) (
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
        default = pkgs.callPackage ./nix/package.nix { };
      });

      devShells = eachSystem (pkgs: {
        default = pkgs.callPackage ./nix/dev.nix { };
      });
    };
}
