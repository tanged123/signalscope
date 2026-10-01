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
        hdf5Root = pkgs.symlinkJoin {
          name = "hdf5";
          paths = [
            pkgs.hdf5
            pkgs.hdf5.dev
          ];
        };

        treefmtEval = treefmt-nix.lib.evalModule pkgs {
          projectRootFile = "flake.nix";
          programs.nixfmt.enable = true;
          programs.prettier.enable = true;
          programs.rustfmt = {
            enable = true;
            edition = "2024";
          };
          programs.shfmt = {
            enable = true;
            indent_size = 2;
          };
          programs.taplo.enable = true;
        };

        linuxPackages = lib.optionals pkgs.stdenv.isLinux (
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
          ]
        );
      in
      {
        devShells.default = pkgs.mkShell {
          packages =
            with pkgs;
            [
              actionlint
              binutils
              cargo
              cargo-deny
              cargo-llvm-cov
              cargo-machete
              cargo-zigbuild
              clippy
              cmake
              hdf5Root
              llvmPackages.llvm
              nodejs_22
              patchelf
              pnpm
              pkg-config
              rustc
              rustfmt
              shellcheck
              treefmtEval.config.build.wrapper
              typos
              zig
              zizmor
            ]
            ++ lib.optionals pkgs.stdenv.isLinux [
              electron_43
              mold
            ]
            ++ linuxPackages;

          shellHook = ''
            # Size local Cargo parallelism by memory, not cores: optimized
            # dependency builds peak near 3 GiB per rustc job, and exceeding
            # the WSL VM's memory kills the whole VM. CI runners use every core.
            if [ -z "''${CI:-}" ] && [ -z "''${CARGO_BUILD_JOBS:-}" ]; then
              signalscope_mem_gib=$(( $(getconf _PHYS_PAGES 2>/dev/null || echo 0) * $(getconf PAGESIZE 2>/dev/null || echo 0) / 1073741824 ))
              signalscope_cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)
              CARGO_BUILD_JOBS=$(( signalscope_mem_gib / 3 ))
              if [ "$CARGO_BUILD_JOBS" -gt "$signalscope_cores" ]; then
                CARGO_BUILD_JOBS=$signalscope_cores
              fi
              if [ "$CARGO_BUILD_JOBS" -lt 2 ]; then
                CARGO_BUILD_JOBS=2
              fi
              export CARGO_BUILD_JOBS
              unset signalscope_mem_gib signalscope_cores
            fi
            export RUST_BACKTRACE=1
            export HDF5_DIR="${hdf5Root}"
            ${lib.optionalString pkgs.stdenv.isLinux ''
              # GNU ld dominates incremental relinks of scope-server; mold is
              # several times faster. Release packaging links with zig instead.
              export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS="-C link-arg=-fuse-ld=mold"
              export SIGNALSCOPE_ELECTRON_BIN="${pkgs.electron_43}/bin/electron"
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
