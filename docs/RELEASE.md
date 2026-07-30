# wmux Release Process

wmux is distributed as a **portable zip** (not NSIS installer) because without code-signing,
Windows SmartScreen flags installers more aggressively than zip extractions.

## Step-by-step

```bash
# 1. Build everything
npm run build:main        # Compile TS → dist/main/, dist/preload/, dist/cli/
npx vite build            # Build renderer → dist/renderer/

# 2. Verify compiled code
python -c "import re; f=open('dist/renderer/assets/index-*.js').read(); print('OK' if 'your_fix_marker' in f else 'MISSING')"
grep -c 'your_fix_string' dist/main/index.js

# 3. Create ASAR staging
# IMPORTANT: always run from the project root (use absolute paths or cd back
# after any `cd .asar-staging`). If cwd drifts into .asar-staging during this
# section, subsequent `mkdir build-out` lands INSIDE the staging dir and the
# next asar pack will recursively include its own previous output → 188M asar.
rm -rf .asar-staging build-out
mkdir -p .asar-staging build-out
cp -r dist .asar-staging/dist          # explicit dest path — trailing-slash form is flaky on Git Bash
cp package.json .asar-staging/package.json
( cd .asar-staging && npm install --omit=dev --ignore-scripts )   # subshell — cwd doesn't leak

# 4. Pack ASAR (with native module unpacking)
# Use --unpack-dir (path-based), NOT --unpack "**/*.node" — the glob form
# silently fails on Git Bash for Windows (shell eats the pattern, asar produces
# the asar but creates no .unpacked dir, no error). Output to build-out/ so we
# never touch the live resources/app.asar while wmux may be running.
npx asar pack .asar-staging build-out/app.asar --unpack-dir "node_modules/node-pty/prebuilds"

# 5. Verify native modules are unpacked
ls build-out/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/
# Must contain: conpty.node, conpty_console_list.node, pty.node
# Sanity: ASAR should be ~24M (natives unpacked). 80M+ means natives weren't
# moved out; 180M+ means staging got polluted (see step 3 warning).

# 5b. Verify the PRs/fixes you intended to ship are actually inside the ASAR.
rm -rf /tmp/asar-verify && mkdir -p /tmp/asar-verify
( cd /tmp/asar-verify && npx --prefix "$(pwd)" asar extract "$(pwd)/build-out/app.asar" . )
grep -c 'your_fix_marker' /tmp/asar-verify/dist/renderer/assets/index-*.js
grep -c 'your_fix_string' /tmp/asar-verify/dist/main/index.js

# 6. Create release staging (base on previous release zip)
rm -rf ../wmux-release-staging
mkdir -p ../wmux-release-staging
( cd ../wmux-release-staging && unzip -q ../wmux/wmux-<PREV_VERSION>-win-x64.zip )

# 7. Copy ASAR + resources into release staging
cp build-out/app.asar ../wmux-release-staging/resources/app.asar
rm -rf ../wmux-release-staging/resources/app.asar.unpacked
cp -r build-out/app.asar.unpacked ../wmux-release-staging/resources/app.asar.unpacked
cp resources/icon.png ../wmux-release-staging/resources/
rm -rf ../wmux-release-staging/resources/themes && cp -r resources/themes ../wmux-release-staging/resources/themes
rm -rf ../wmux-release-staging/resources/sounds && cp -r resources/sounds ../wmux-release-staging/resources/sounds
mkdir -p ../wmux-release-staging/resources/cli && cp dist/cli/wmux.js ../wmux-release-staging/resources/cli/wmux.js
rm -rf ../wmux-release-staging/resources/shell-integration && mkdir -p ../wmux-release-staging/resources/shell-integration
cp -r src/shell-integration/* ../wmux-release-staging/resources/shell-integration/
rm -rf ../wmux-release-staging/resources/wmux-orchestrator && cp -r resources/wmux-orchestrator ../wmux-release-staging/resources/wmux-orchestrator
rm -rf ../wmux-release-staging/resources/opencode-plugin && cp -r resources/opencode-plugin ../wmux-release-staging/resources/opencode-plugin

# 8. Embed icon + metadata in exe (rcedit)
# CRITICAL: rcedit exports `{ rcedit }` (named export). `const rcedit =
# require('rcedit')` followed by `rcedit(...)` throws "rcedit is not a function".
# Always destructure: `const { rcedit } = require('rcedit')`.
node -e "
  const { rcedit } = require('rcedit');
  rcedit('../wmux-release-staging/pswmux.exe', {
    icon: 'resources/icons/icon.ico',
    'version-string': {
      ProductName: 'pswmux',
      FileDescription: 'pswmux',
      CompanyName: 'wmux',
      InternalName: 'pswmux',
      OriginalFilename: 'pswmux.exe',
      LegalCopyright: 'Copyright (c) 2026 wmux'
    },
    'file-version': '0.7.20',
    'product-version': '0.7.20'
  }).then(() => console.log('rcedit done'), e => { console.error(e); process.exit(1); });
"
# NOTE: rcedit CANNOT modify a running exe. The staging copy is fine; never
# point rcedit at the pswmux.exe living in the project root if it's running.

# 9. Create zip
powershell -NoProfile -Command "Compress-Archive -Path '..\wmux-release-staging\*' -DestinationPath '..\pswmux-<VERSION>-win-x64.zip' -CompressionLevel Optimal"

# 10. Tag, push, publish
git add package.json package-lock.json && git commit -m "chore(release): bump to <VERSION>"
git push origin master
git tag -a v<VERSION> -m "wmux <VERSION>" && git push origin v<VERSION>
gh release create v<VERSION> ../pswmux-<VERSION>-win-x64.zip --repo amirlehmam/wmux --title "v<VERSION>" --notes "..."

# 11. (Optional) Hot-swap into the locally running wmux for immediate testing
cp build-out/app.asar resources/app.asar
rm -rf resources/app.asar.unpacked && cp -r build-out/app.asar.unpacked resources/app.asar.unpacked
# Then restart wmux to pick up changes

# 12. Cleanup
rm -rf .asar-staging build-out /tmp/asar-verify ../wmux-release-staging
```

## Release Checklist

- [ ] `npm run build:main` succeeds
- [ ] `npx vite build` succeeds
- [ ] Compiled code verified (grep for key changes in dist/)
- [ ] ASAR packed with `--unpack-dir node_modules/node-pty/prebuilds` (NOT `--unpack` glob)
- [ ] ASAR size is ~24M (natives unpacked). 80M+ ⇒ unpack didn't take. 180M+ ⇒ staging polluted.
- [ ] node-pty native modules present in `app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/`
- [ ] PR-specific markers grep-confirmed inside the packed ASAR (extracted to /tmp)
- [ ] wmux-orchestrator plugin copied to release staging
- [ ] OpenCode plugin copied to release staging
- [ ] rcedit applied (icon + version metadata) — `{ rcedit }` destructured
- [ ] Zip created and uploaded to GitHub release
- [ ] Mark of the Web: remind user to right-click > Unblock after download

## Important Notes

- **rcedit can't modify a running exe** — always work on a copy
- **rcedit named export**: `const { rcedit } = require('rcedit')`. Non-destructured `const rcedit = require('rcedit')` throws "rcedit is not a function" (different from older docs).
- **asar `--unpack` glob silently fails on Git Bash for Windows**: pattern like `"**/*.node"` gets shell-eaten and asar emits no `.unpacked/` dir, no error. Use `--unpack-dir node_modules/node-pty/prebuilds` (path-based) instead.
- **Bash cwd drift can recursively pollute staging**: if you `cd .asar-staging` and forget to come back, the next `mkdir build-out && asar pack` creates `.asar-staging/build-out/app.asar`, and a re-pack will swallow its own output into the new asar (188M). Always use subshells `( cd dir && cmd )` or absolute paths.
- **Don't pack ASAR directly to `resources/app.asar`** if wmux may be running — pack to `build-out/` and copy at step 7.
- **MOTW (Mark of the Web)**: Downloaded zips get `Zone.Identifier` NTFS stream. Fix: `powershell "Get-ChildItem -Recurse | Unblock-File"`
- **Windows taskbar pinning** uses PE `FileDescription` for the shortcut name — ensure rcedit sets it to "pswmux"
- **AppUserModelId** is set to `com.wmux.app` in `src/main/index.ts` for proper taskbar grouping
- **Application exe name is `pswmux.exe`**. The CLI and internal runtime identifiers remain `wmux`.
