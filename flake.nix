
{
  description = "rebase development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [
          python313
          uv
          ruff
	  codex
          opencode
          basedpyright
          nodejs_22
        ];

        shellHook = ''
          export PYTHONUNBUFFERED=1
          export PYTHONDONTWRITEBYTECODE=1

          echo "Welcome to rebase development"
          echo "Python: $(python --version)"
          echo "Node: $(node --version)"
          echo "uv: $(uv --version)"
        '';
      };
    };
}
