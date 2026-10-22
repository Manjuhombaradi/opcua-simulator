abi <abi/4.0>,
include <tunables/global>

# electron-builder's default profile, extended to the real Electron binary: build/afterPack.js turns
# ${executable} into a launcher script and renames the binary to ${executable}.bin.
profile "${executable}" "/opt/${sanitizedProductName}/${executable}{,.bin}" flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/${executable}>
}
