abi <abi/4.0>,
include <tunables/global>

# electron-builder's default profile, extended to the real Electron binary: build/afterPack.js turns
# ${executable} into a launcher script and renames the binary to ${executable}.bin.
# It allows user namespaces, so Chromium's sandbox works on Ubuntu 23.10+ (restricted user namespaces).
# The launcher keeps the sandbox on when it runs under this profile: keep the profile name "${executable}".
profile "${executable}" "/opt/${sanitizedProductName}/${executable}{,.bin}" flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/${executable}>
}
