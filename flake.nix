{
  description = "SignalScope: high-performance time-series analysis workbench";

  nixConfig = {
    extra-substituters = [ "https://tanged123.cachix.org" ];
    extra-trusted-public-keys = [
      "tanged123.cachix.org-1:S79iH77XKs7/Ap+z9oaafrhmrw6lQ21QDzxyNqg1UVI="
    ];
  };

  inputs = {
    flake-utils.url = "github:numtide/flake-utils";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    treefmt-nix.url = "github:numtide/treefmt-nix";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      treefmt-nix,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        lib = pkgs.lib;

        treefmtEval = treefmt-nix.lib.evalModule pkgs {
          projectRootFile = "flake.nix";
          programs.nixfmt.enable = true;
          programs.prettier.enable = true;
          programs.rustfmt = {
            enable = true;
            edition = "2024";
          };
          programs.taplo.enable = true;
        };

        linuxTauriPackages = lib.optionals pkgs.stdenv.isLinux (
          with pkgs;
          [
            at-spi2-atk
            atkmm
            cairo
            chromium
            gdk-pixbuf
            glib
            gsettings-desktop-schemas
            gtk3
            libsoup_3
            librsvg
            pango
            webkitgtk_4_1
          ]
        );
      in
      {
        devShells.default = pkgs.mkShell {
          packages =
            with pkgs;
            [
              cargo
              cargo-llvm-cov
              cargo-tauri
              clippy
              llvmPackages.llvm
              nodejs_22
              pnpm
              pkg-config
              rustc
              rustfmt
              treefmtEval.config.build.wrapper
            ]
            ++ linuxTauriPackages;

          shellHook = ''
            export CARGO_BUILD_JOBS="''${CARGO_BUILD_JOBS:-2}"
            export RUST_BACKTRACE=1
            ${lib.optionalString pkgs.stdenv.isLinux ''
              export PLAYWRIGHT_BROWSERS_PATH=0
              export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="${pkgs.chromium}/bin/chromium"
              export XDG_DATA_DIRS="${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:''${XDG_DATA_DIRS:-}"
            ''}

            echo "SignalScope dev environment loaded"
            echo "  - Rust: $(rustc --version)"
            echo "  - Node: $(node --version)"
            echo "  - pnpm: $(pnpm --version)"
          '';
        };

        formatter = treefmtEval.config.build.wrapper;

        checks = {
          formatting = treefmtEval.config.build.check self;
        };
      }
    );
}
