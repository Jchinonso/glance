// Regenerates the app icon (build/icon.icns), the menu bar icon
// (src/assets/trayTemplate*.png) and the in-app logo (src/ui/logo.png) from
// build/icon.svg and src/assets/tray.svg.
//   node_modules/.bin/electron scripts/make-icon.mjs
import { app, BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function render(svgFile, size) {
  const win = new BrowserWindow({ width: size, height: size, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  const svg = readFileSync(svgFile, "utf8");
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace("<svg ", `<svg width="${size}" height="${size}" style="display:block" `)}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = (await win.webContents.capturePage()).resize({ width: size, height: size, quality: "best" });
  win.destroy();
  return image;
}

app.dock?.hide();
// Each render closes its window; that must not quit the script.
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  const icon = await render(path.join(root, "build", "icon.svg"), 1024);
  const set = path.join(root, "build", "icon.iconset");
  rmSync(set, { recursive: true, force: true });
  mkdirSync(set);
  for (const pt of [16, 32, 128, 256, 512]) {
    writeFileSync(path.join(set, `icon_${pt}x${pt}.png`), icon.resize({ width: pt, height: pt, quality: "best" }).toPNG());
    writeFileSync(path.join(set, `icon_${pt}x${pt}@2x.png`), icon.resize({ width: pt * 2, height: pt * 2, quality: "best" }).toPNG());
  }
  execFileSync("/usr/bin/iconutil", ["-c", "icns", set, "-o", path.join(root, "build", "icon.icns")]);
  rmSync(set, { recursive: true, force: true });
  writeFileSync(path.join(root, "src", "ui", "logo.png"), icon.resize({ width: 128, height: 128, quality: "best" }).toPNG());

  const tray = await render(path.join(root, "src", "assets", "tray.svg"), 144);
  writeFileSync(path.join(root, "src", "assets", "trayTemplate.png"), tray.resize({ width: 18, height: 18, quality: "best" }).toPNG());
  writeFileSync(path.join(root, "src", "assets", "trayTemplate@2x.png"), tray.resize({ width: 36, height: 36, quality: "best" }).toPNG());
  app.quit();
});
