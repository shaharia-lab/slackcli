{
  lib,
  stdenv,
  bun2nix,
}:
let
  packageJson = lib.importJSON ../package.json;
in
stdenv.mkDerivation {
  pname = packageJson.name;
  inherit (packageJson) version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../bun.lock
      ../package.json
      ../tsconfig.json
      ../scripts
      ../src
    ];
  };

  nativeBuildInputs = [ bun2nix.hook ];
  bunDeps = bun2nix.fetchBunDeps { bunNix = ./bun.nix; };

  buildPhase = "bun run build";
  installPhase = "install -Dm755 dist/${packageJson.name} $out/bin/${packageJson.name}";
  dontFixup = true;
}
