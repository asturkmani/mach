// The shell script that turns a fresh sandbox into Mach's data workbench.
// Shared by the app (lib/sandbox.ts) and scripts/sandbox-template.mjs.

export const JOB_DIR = "/vercel/job";

/** Runs as root: Python data stack, LibreOffice (to recalculate xlsx formulas) and the `recalc` helper. */
export function setupScript(template) {
  return `set -e
export DEBIAN_FRONTEND=noninteractive
uv pip install --system --quiet ${template.python.join(" ")}
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends ${template.apt.join(" ")} >/dev/null
# LibreOffice recalculates formulas when it opens an xlsx, so files written by
# openpyxl get real values that previews and checks can read.
mkdir -p /home/ubuntu/.config/libreoffice/4/user
cat > /home/ubuntu/.config/libreoffice/4/user/registrymodifications.xcu <<'XCU'
<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>
</oor:items>
XCU
chown -R ubuntu:ubuntu /home/ubuntu/.config
cat > /usr/local/bin/recalc <<'SH'
#!/usr/bin/env bash
# recalc FILE.xlsx: recalculates every formula and saves the results into the file.
set -euo pipefail
file="$(realpath "$1")"
out="$(mktemp -d)"
soffice --headless --calc --convert-to xlsx --outdir "$out" "$file" >/dev/null 2>&1
mv "$out/$(basename "$file")" "$file"
rm -rf "$out"
SH
chmod +x /usr/local/bin/recalc
mkdir -p ${JOB_DIR} /vercel/drive && chown ubuntu:ubuntu ${JOB_DIR} /vercel/drive
`;
}
