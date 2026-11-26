{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  buildInputs = [
    pkgs.python3
    pkgs.erofs-utils
    pkgs.nodejs_24
  ];
}
