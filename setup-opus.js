const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Install @discordjs/opus shim using mediaplex
const dir = path.join(__dirname, "node_modules", "@discordjs", "opus");
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(
  path.join(dir, "package.json"),
  JSON.stringify({ name: "@discordjs/opus", version: "0.9.0", main: "index.js" })
);
fs.writeFileSync(
  path.join(dir, "index.js"),
  'const { OpusEncoder } = require("mediaplex");\nmodule.exports = { OpusEncoder };\n'
);
console.log("Opus shim installed.");

// Install ffmpeg-static binary
const ffmpegPath = path.join(__dirname, "node_modules", "ffmpeg-static");
if (fs.existsSync(ffmpegPath)) {
  try {
    execSync("node install.js", { cwd: ffmpegPath, stdio: "inherit" });
    console.log("ffmpeg-static installed.");
  } catch (e) {
    console.log("ffmpeg-static: manual install needed, running install.js...");
    try {
      require("ffmpeg-static");
      console.log("ffmpeg-static already available.");
    } catch {
      console.error("WARNING: ffmpeg-static binary not found!");
    }
  }
}
