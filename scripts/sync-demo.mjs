/**
 * sync-demo.mjs — copy the built plugin into the demo vault.
 *
 * The repo root IS the plugin (manifest.json at root, as Obsidian requires).
 * demo-vault/ is sample content; for "clone → open demo-vault → it just works",
 * the built runtime files must also live under demo-vault/.obsidian/plugins/lifelog/.
 * Build runs this automatically; the copies are committed so no build is needed
 * to try the demo.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEST = join(ROOT, "demo-vault", ".obsidian", "plugins", "lifelog");

mkdirSync(DEST, { recursive: true });
for (const f of ["manifest.json", "main.js"]) {
  const src = join(ROOT, f);
  if (!existsSync(src)) {
    console.error(`✗ ${f} not found — run the build first`);
    process.exit(1);
  }
  copyFileSync(src, join(DEST, f));
}
console.log("✓ synced plugin → demo-vault/.obsidian/plugins/lifelog/");
