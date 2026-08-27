const {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  REST,
  Routes,
  ActivityType,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  NoSubscriberBehavior,
  StreamType,
} = require("@discordjs/voice");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

process.env.FFMPEG_PATH = require("ffmpeg-static");

const PORT = process.env.PORT || 3000;

let webPanelHtml = "";
try { webPanelHtml = fs.readFileSync(path.join(__dirname, "webpanel.html"), "utf-8"); }
catch (e) { console.error("[web] cannot read webpanel.html:", e.message); }

const BODY_LIMIT = 64 * 1024 * 1024;

function serveJSON(res, obj) {
  try {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(obj));
  } catch { /* ignore */ }
}

function serveStatus(res, code, msg) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: code >= 200 && code < 300, message: msg }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new Error("Payload too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipart(body, ctype) {
  const boundaryMatch = ctype.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]).trim() : null;
  if (!boundary) return { data: body, filename: null };
  const delim = Buffer.from("--" + boundary);
  const idx = body.indexOf(delim);
  if (idx === -1) return { data: body, filename: null };
  const start = idx + delim.length;
  const nextDelim = Buffer.from("\r\n--" + boundary);
  const endIdx = body.indexOf(nextDelim, start);
  if (endIdx === -1) return { data: body, filename: null };
  const part = body.slice(start, endIdx);
  const headEnd = part.indexOf("\r\n\r\n");
  const head = headEnd === -1 ? "" : part.slice(0, headEnd).toString("utf-8");
  const data = headEnd === -1 ? Buffer.alloc(0) : part.slice(headEnd + 4);
  if (data.length >= 2 && data[data.length - 2] === 13 && data[data.length - 1] === 10) {
    return { data: data.slice(0, data.length - 2), filename: extractFilename(head) };
  }
  return { data, filename: extractFilename(head) };
}

function extractFilename(head) {
  const m = head.match(/filename="?([^";]+)"?/i);
  return m ? m[1].replace(/[^a-zA-Z0-9 ._()-]/g, "_") : null;
}

function getState() {
  return {
    ok: true,
    playing: isPlaying,
    stopped: isStopped,
    status: isPlaying ? "Playing" : isStopped ? "Stopped" : "Idle",
    currentTrack: playlist.length > 0 ? (playlist[currentIndex] || null) : null,
    trackIndex: playlist.length > 0 ? currentIndex : -1,
    trackCount: playlist.length,
    playlist: currentPlaylistName,
    playlists: listPlaylists(),
    tracks: playlist,
    loop: loopEnabled,
    shuffle: shuffleEnabled,
    position: isPlaying ? currentPosition : (seekPos || 0),
    duration: trackDuration,
    connected: !!connection,
    uptime: process.uptime().toFixed(0),
  };
}

http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  const u = new URL(req.url, "http://localhost");

  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(webPanelHtml);
  }

  if (url === "/api/state") return serveJSON(res, getState());

  if (url === "/api/play") { ensurePlay(); return serveJSON(res, getState()); }
  if (url === "/api/pause") { if (player && player.state.status === AudioPlayerStatus.Playing) { player.pause(); isPlaying = false; } return serveJSON(res, getState()); }
  if (url === "/api/resume") { if (player && player.state.status === AudioPlayerStatus.Paused) { player.unpause(); isPlaying = true; isStopped = false; } return serveJSON(res, getState()); }
  if (url === "/api/stop") { if (player && !isStopped) { keepPosOnStop = true; seekPos = currentPosition; manualAction = true; player.stop(); isPlaying = false; isStopped = true; } return serveJSON(res, getState()); }
  if (url === "/api/skip") { if (connection && playlist.length > 0) { manualAction = true; player.stop(); currentIndex++; if (currentIndex >= playlist.length) currentIndex = 0; resetTrackState(); playTrack(); } return serveJSON(res, getState()); }
  if (url === "/api/prev") { if (connection && playlist.length > 0) { manualAction = true; player.stop(); currentIndex -= 2; if (currentIndex < -1) currentIndex = playlist.length - 2; resetTrackState(); playTrack(); } return serveJSON(res, getState()); }
  if (url === "/api/loop") { loopEnabled = !loopEnabled; return serveJSON(res, getState()); }
  if (url === "/api/shuffle") { shuffleEnabled = !shuffleEnabled; if (shuffleEnabled && playlist.length > 0) { currentIndex = Math.floor(Math.random() * playlist.length); if (isPlaying && connection) { manualAction = true; player.stop(); resetTrackState(); playTrack(); } } return serveJSON(res, getState()); }
  if (url === "/api/disconnect") { disconnect(); return serveJSON(res, getState()); }
  if (url === "/api/join") { ensurePlay(); return serveJSON(res, getState()); }

  if (url === "/api/seek") {
    const t = parseFloat(u.searchParams.get("t"));
    if (isNaN(t)) return serveStatus(res, 400, "Invalid t");
    seekTo(t);
    return serveJSON(res, getState());
  }
  if (url === "/api/seekby") {
    const d = parseFloat(u.searchParams.get("d"));
    if (isNaN(d)) return serveStatus(res, 400, "Invalid d");
    seekBy(d);
    return serveJSON(res, getState());
  }

  if (url === "/api/select") {
    const idx = parseInt(u.searchParams.get("i"), 10);
    playlist = loadPlaylist();
    if (isNaN(idx) || idx < 0 || idx >= playlist.length) return serveStatus(res, 400, "Invalid index");
    if (!connection) return serveStatus(res, 400, "Not connected. Press play first.");
    manualAction = true; player.stop(); currentIndex = idx; resetTrackState(); playTrack();
    return serveJSON(res, getState());
  }

  if (url === "/api/createplaylist") {
    const name = (u.searchParams.get("name") || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!name) return serveStatus(res, 400, "Invalid name");
    const dir = getPlaylistDir(name);
    if (fs.existsSync(dir)) return serveStatus(res, 400, "Playlist already exists");
    fs.mkdirSync(dir, { recursive: true });
    return serveJSON(res, { ok: true, message: `Created playlist "${name}"`, playlists: listPlaylists() });
  }

  if (url === "/api/deleteplaylist") {
    const name = (u.searchParams.get("name") || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!name || name === DEFAULT_PLAYLIST) return serveStatus(res, 400, "Cannot delete this playlist");
    const dir = getPlaylistDir(name);
    if (!fs.existsSync(dir)) return serveStatus(res, 400, "Playlist not found");
    fs.rmSync(dir, { recursive: true, force: true });
    if (currentPlaylistName === name) {
      currentPlaylistName = DEFAULT_PLAYLIST;
      playlist = loadPlaylist();
      currentIndex = 0;
      resetTrackState();
      if (connection && isPlaying) { manualAction = true; player.stop(); playTrack(); }
    }
    return serveJSON(res, { ok: true, message: `Deleted "${name}"`, playlists: listPlaylists() });
  }

  if (url === "/api/playlist") {
    const name = (u.searchParams.get("name") || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const dir = getPlaylistDir(name);
    if (!fs.existsSync(dir)) return serveStatus(res, 400, "Playlist not found");
    currentPlaylistName = name; playlist = loadPlaylist(); currentIndex = 0; resetTrackState();
    if (connection && isPlaying) { manualAction = true; player.stop(); playTrack(); }
    return serveJSON(res, getState());
  }

  if (req.method === "POST" && url === "/api/upload") {
    try {
      const body = await readBody(req);
      const target = (u.searchParams.get("playlist") || currentPlaylistName).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
      const dir = getPlaylistDir(target);
      if (!fs.existsSync(dir)) return serveStatus(res, 400, "Playlist not found");
      const ctype = req.headers["content-type"] || "";
      let filename = "upload" + Date.now() + ".mp3";
      let data = body;
      if (ctype.includes("multipart/form-data")) {
        const parsed = parseMultipart(body, ctype);
        if (parsed.filename) filename = parsed.filename;
        data = parsed.data;
      } else {
        const cd = req.headers["content-disposition"] || "";
        const nm = cd.match(/filename="?([^";]+)"?/i);
        if (nm && /\.(mp3|mp4|mkv|webm|ogg|wav)$/i.test(nm[1])) filename = nm[1].replace(/[^a-zA-Z0-9 ._()-]/g, "_");
      }
      if (!/\.(mp3|mp4|mkv|webm|ogg|wav)$/i.test(filename)) return serveStatus(res, 400, "Unsupported file type");
      fs.writeFileSync(path.join(dir, filename), data);
      playlist = loadPlaylist();
      return serveJSON(res, { ok: true, message: `Uploaded ${filename} to "${target}"` });
    } catch (err) {
      return serveStatus(res, 500, err.message);
    }
  }

  return serveStatus(res, 404, "Not found");
}).listen(PORT, () => console.log(`[web] keep-alive server on port ${PORT}`));

function ensurePlay() {
  const run = (target) => {
    try {
      const g = client.guilds.cache.first();
      if (!g) { console.error("[web] no guild"); return; }
      let ch;
      const cached = client.channels.cache.get(target);
      if (cached && cached.isVoiceBased()) ch = cached;
      if (!ch) { client.channels.fetch(target).then((c) => { if (!c || !c.isVoiceBased()) return; attachAndPlay(c, g); }).catch(() => {}); return; }
      attachAndPlay(ch, g);
    } catch (e) { console.error("[web play]", e.message); }
  };
  if (connection) {
    if (player.state.status === AudioPlayerStatus.Paused) { player.unpause(); isPlaying = true; isStopped = false; }
    else if (player.state.status === AudioPlayerStatus.Idle && playlist.length > 0) { isStopped = false; playTrack(); }
    else if (playlist.length === 0) { playlist = loadPlaylist(); }
    return;
  }
  playlist = loadPlaylist();
  if (playlist.length === 0) return;
  run(VOICE_CHANNEL_ID);
}

function attachAndPlay(channel, guild) {
  try {
    connection = joinVoiceChannel({
      channelId: channel.id, guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: false,
    });
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch { connection = null; isPlaying = false; }
    });
    entersState(connection, VoiceConnectionStatus.Ready, 30_000).then(() => {
      connection.subscribe(player);
      currentIndex = 0;
      isStopped = false;
      isPlaying = true;
      resetTrackState();
      playTrack();
    }).catch(() => { connection = null; });
  } catch (e) { console.error("[web attach]", e.message); }
}

function disconnect() {
  try {
    if (player) { manualAction = true; player.stop(); }
    isPlaying = false;
    isStopped = true;
    resetTrackState();
    if (connection) {
      connection.destroy();
      connection = null;
    }
    console.log("[web] disconnected from voice channel");
  } catch (e) { console.error("[web disconnect]", e.message); }
}

function getConfig() {
  try {
    return require("./config.json");
  } catch {
    return {};
  }
}
const cfg = getConfig();
const token = process.env.TOKEN || cfg.token;
console.log("[debug] TOKEN from env:", process.env.TOKEN ? "set (len " + process.env.TOKEN.length + ")" : "NOT SET", "| from config:", cfg.token ? "set (len " + cfg.token.length + ")" : "NOT SET");
const VOICE_CHANNEL_ID = "1486400056759292126";
const PLAYLISTS_DIR = path.join(__dirname, "playlists");
const DEFAULT_PLAYLIST = "default";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

setInterval(() => {
  const data = Math.random().toString(36).substring(2, 10);
  console.log(`[keepalive] heartbeat ${data}`);
}, 60_000);

let connection = null;
let player = null;
let playlist = [];
let currentIndex = 0;
let isPlaying = false;
let isStopped = false;
let manualAction = false;
let loopEnabled = false;
let shuffleEnabled = false;
let keepPosOnStop = false;
let currentPlaylistName = DEFAULT_PLAYLIST;
let seekPos = 0;
let trackDuration = null;
let currentPosition = 0;
let positionTimer = null;

function getPlaylistDir(name) {
  return path.join(PLAYLISTS_DIR, name || currentPlaylistName);
}

function loadPlaylist(name) {
  const dir = getPlaylistDir(name);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); return []; }
  return fs.readdirSync(dir).filter((f) => /\.(mp3|mp4|mkv|webm|ogg|wav)$/i.test(f)).sort();
}

function listPlaylists() {
  if (!fs.existsSync(PLAYLISTS_DIR)) { fs.mkdirSync(PLAYLISTS_DIR, { recursive: true }); return []; }
  return fs.readdirSync(PLAYLISTS_DIR).filter((item) => fs.statSync(path.join(PLAYLISTS_DIR, item)).isDirectory());
}

function createMediaResource(filePath, seekSec) {
  const args = [];
  if (seekSec) args.push("-ss", String(seekSec));
  args.push(
    "-i", filePath,
    "-f", "ogg",
    "-c:a", "libopus",
    "-ar", "48000",
    "-ac", "2",
    "-b:a", "128k",
    "-vn",
    "pipe:1",
  );
  const ffmpeg = spawn(process.env.FFMPEG_PATH, args, { stdio: ["ignore", "pipe", "ignore"] });
  return createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus });
}

function getMediaDuration(filePath) {
  return new Promise((resolve) => {
    const ff = spawn(process.env.FFMPEG_PATH, ["-i", filePath], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    ff.stderr.on("data", (d) => { err += d.toString(); });
    ff.on("close", () => {
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      resolve(m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null);
    });
  });
}

function startPositionTimer() {
  stopPositionTimer();
  currentPosition = seekPos || 0;
  positionTimer = setInterval(() => {
    if (isPlaying && !isStopped && player && player.state.status === AudioPlayerStatus.Playing) {
      currentPosition += 1;
    }
  }, 1000);
}

function stopPositionTimer() {
  if (positionTimer) { clearInterval(positionTimer); positionTimer = null; }
}

function resetTrackState() {
  stopPositionTimer();
  seekPos = 0;
  currentPosition = 0;
  trackDuration = null;
}

function playTrack() {
  if (!connection || playlist.length === 0) return;
  if (currentIndex >= playlist.length) currentIndex = 0;
  if (currentIndex < 0) currentIndex = playlist.length - 1;

  const file = playlist[currentIndex];
  const filePath = path.join(getPlaylistDir(currentPlaylistName), file);
  console.log(`[PLAY] ${file} (${currentIndex + 1}/${playlist.length})` + (seekPos ? ` from ${seekPos}s` : ""));

  try {
    trackDuration = null;
    getMediaDuration(filePath).then((d) => { trackDuration = d; });
    const resource = createMediaResource(filePath, seekPos || null);
    resource.playStream.on("error", (e) => console.error("[STREAM ERROR]", e.message));
    player.play(resource);
    isPlaying = true;
    isStopped = false;
    startPositionTimer();
  } catch (err) {
    console.error("[PLAY ERROR]", err.message);
  }
}

function seekTo(target) {
  if (!connection || playlist.length === 0) return;
  if (trackDuration && target >= trackDuration) {
    manualAction = true;
    player.stop();
    resetTrackState();
    currentIndex++;
    if (currentIndex >= playlist.length) currentIndex = 0;
    playTrack();
    return;
  }
  if (target < 0) target = 0;
  manualAction = true;
  player.stop();
  seekPos = target;
  playTrack();
}

function seekBy(delta) {
  if (!connection || playlist.length === 0) return;
  const base = isPlaying ? currentPosition : 0;
  seekTo(Math.max(0, base + delta));
}

player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });

player.on(AudioPlayerStatus.Playing, () => console.log("[PLAYER] PLAYING"));

player.on(AudioPlayerStatus.Idle, () => {
  console.log("[PLAYER] IDLE");
  if (keepPosOnStop) {
    keepPosOnStop = false;
    stopPositionTimer();
    return;
  }
  if (manualAction) { manualAction = false; resetTrackState(); return; }
  if (isStopped) { resetTrackState(); return; }
  resetTrackState();
  if (isStopped) { return; }
  if (loopEnabled) {
    playTrack();
  } else if (shuffleEnabled && playlist.length > 0) {
    let ni;
    do { ni = Math.floor(Math.random() * playlist.length); } while (ni === currentIndex && playlist.length > 1);
    currentIndex = ni;
    playTrack();
  } else {
    currentIndex++;
    playTrack();
  }
});

player.on("error", (error) => {
  console.error("[PLAYER ERROR]", error.message);
  resetTrackState();
  currentIndex++;
  playTrack();
});

function fmtTime(sec) {
  if (sec == null || isNaN(sec)) return "--:--";
  sec = Math.floor(sec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function buildPanelEmbed() {
  const current = playlist.length > 0 ? (playlist[currentIndex] || "None") : "No tracks";
  const posFmt = fmtTime(isPlaying ? currentPosition : seekPos);
  const durFmt = fmtTime(trackDuration);
  return new EmbedBuilder()
    .setColor(isPlaying ? 0x1DB954 : 0x99AAB5)
    .setTitle("Radio Control Panel")
    .setDescription(
      `**Status:** ${isPlaying ? "Playing" : isStopped ? "Stopped" : "Idle"}\n` +
      `**Now playing:** ${current}\n` +
      `**Track:** ${playlist.length > 0 ? currentIndex + 1 : 0}/${playlist.length}\n` +
      (trackDuration ? `**Position:** ${posFmt} / ${durFmt}\n` : "") +
      `**Loop:** ${loopEnabled ? "ON" : "OFF"}\n` +
      `**Playlist:** ${currentPlaylistName}`
    );
}

function buildComponents() {
  const rows = [];
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("btn_prev").setLabel("◀◀").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("btn_stop").setLabel("⏹").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("btn_play").setLabel("▶").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("btn_pause").setLabel("⏸").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("btn_skip").setLabel("▶▶").setStyle(ButtonStyle.Secondary),
  ));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("btn_back15").setLabel("◀ 15s").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("btn_back60").setLabel("◀ 60s").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("btn_fwd60").setLabel("60s ▶").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("btn_fwd15").setLabel("15s ▶").setStyle(ButtonStyle.Secondary),
  ));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("btn_loop").setLabel(loopEnabled ? "🔁 Loop: ON" : "🔁 Loop: OFF").setStyle(loopEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("btn_panel").setLabel("🔄 Refresh").setStyle(ButtonStyle.Secondary),
  ));
  if (playlist.length > 0) {
    const trackOptions = playlist.slice(0, 25).map((f, i) => ({
      label: f.length > 95 ? f.substring(0, 92) + "..." : f,
      value: String(i),
      description: `${i + 1}/${playlist.length}${i === currentIndex ? " (playing)" : ""}`,
    }));
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("track_select")
        .setPlaceholder(playlist[currentIndex] ? `Now: ${playlist[currentIndex]}` : "Choose a track...")
        .addOptions(trackOptions)
    ));
  }
  const pls = listPlaylists();
  if (pls.length > 0) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("playlist_switch")
        .setPlaceholder(`Playlist: ${currentPlaylistName}`)
        .addOptions(pls.map((name) => ({
          label: name,
          value: name,
          description: `${loadPlaylist(name).length} tracks${name === currentPlaylistName ? " (active)" : ""}`,
        })))
    ));
  }
  return rows;
}

function updatePanel(interaction) {
  return interaction.update({ embeds: [buildPanelEmbed()], components: buildComponents() });
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  client.user.setActivity("Radio", { type: ActivityType.Listening });

  if (!fs.existsSync(PLAYLISTS_DIR)) fs.mkdirSync(PLAYLISTS_DIR, { recursive: true });
  const defDir = path.join(PLAYLISTS_DIR, DEFAULT_PLAYLIST);
  if (!fs.existsSync(defDir)) fs.mkdirSync(defDir, { recursive: true });

  const commands = [
    new SlashCommandBuilder().setName("panel").setDescription("Open radio control panel"),
    new SlashCommandBuilder().setName("add").setDescription("Add a file to a playlist")
      .addAttachmentOption((o) => o.setName("file").setDescription("Audio or video file").setRequired(true))
      .addStringOption((o) => o.setName("playlist").setDescription("Target playlist (default: current)")),
    new SlashCommandBuilder().setName("addurl").setDescription("Download music from URL to a playlist")
      .addStringOption((o) => o.setName("url").setDescription("Direct link to audio/video file").setRequired(true))
      .addStringOption((o) => o.setName("playlist").setDescription("Target playlist (default: current)")),
    new SlashCommandBuilder().setName("createplaylist").setDescription("Create a new playlist")
      .addStringOption((o) => o.setName("name").setDescription("Playlist name").setRequired(true)),
    new SlashCommandBuilder().setName("deleteplaylist").setDescription("Delete a playlist")
      .addStringOption((o) => o.setName("name").setDescription("Playlist name").setRequired(true)),
    new SlashCommandBuilder().setName("nowplaying").setDescription("Show what's playing now"),
  ].map((cmd) => cmd.toJSON());

  const rest = new REST({ version: "10" }).setToken(token);
  try {
    await rest.put(Routes.applicationCommands(c.user.id), { body: commands });
    console.log("Slash commands registered:", commands.map((c) => c.name).join(", "));
  } catch (err) {
    console.error("Command registration error:", err);
  }

  playlist = loadPlaylist();
  console.log(`Loaded ${playlist.length} tracks from playlist "${currentPlaylistName}"`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  const guild = interaction.guild || client.guilds.cache.get(interaction.guildId);
  if (!guild) {
    if (interaction.isRepliable()) return interaction.reply({ content: "Use this in a server.", flags: 64 });
    return;
  }

  if (interaction.isButton()) {
    const id = interaction.customId;

    if (id === "btn_play") {
      if (!connection) {
        playlist = loadPlaylist();
        if (playlist.length === 0) {
          return interaction.reply({ content: "Playlist is empty. Use /add to add files.", flags: 64 });
        }
        let channel;
        try { channel = await client.channels.fetch(VOICE_CHANNEL_ID); } catch {
          return interaction.reply({ content: "Could not find voice channel.", flags: 64 });
        }
        if (!channel?.isVoiceBased()) return interaction.reply({ content: "Not a voice channel.", flags: 64 });
        try {
          connection = joinVoiceChannel({
            channelId: channel.id, guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: false,
          });
          connection.on(VoiceConnectionStatus.Disconnected, async () => {
            try {
              await Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
              ]);
            } catch { connection = null; isPlaying = false; }
          });
          await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
          connection.subscribe(player);
          currentIndex = 0;
          isStopped = false;
          isPlaying = true;
          resetTrackState();
          playTrack();
        } catch (err) {
          connection = null;
          return interaction.reply({ content: "Failed to join: " + err.message, flags: 64 });
        }
      } else if (player.state.status === AudioPlayerStatus.Paused) {
        player.unpause();
        isPlaying = true;
        isStopped = false;
      } else if (player.state.status === AudioPlayerStatus.Idle && playlist.length > 0) {
        isStopped = false;
        playTrack();
      }
      return updatePanel(interaction);
    }

    if (id === "btn_stop") {
      if (player) {
        manualAction = true;
        player.stop();
        isPlaying = false;
        isStopped = true;
      }
      return updatePanel(interaction);
    }

    if (id === "btn_pause") {
      if (player && player.state.status === AudioPlayerStatus.Playing) {
        player.pause();
        isPlaying = false;
      }
      return updatePanel(interaction);
    }

    if (id === "btn_skip") {
      if (connection && playlist.length > 0) {
        manualAction = true;
        player.stop();
        currentIndex++;
        if (currentIndex >= playlist.length) currentIndex = 0;
        resetTrackState();
        playTrack();
      }
      return updatePanel(interaction);
    }

    if (id === "btn_prev") {
      if (connection && playlist.length > 0) {
        manualAction = true;
        player.stop();
        currentIndex -= 2;
        if (currentIndex < -1) currentIndex = playlist.length - 2;
        resetTrackState();
        playTrack();
      }
      return updatePanel(interaction);
    }

    if (id === "btn_loop") {
      loopEnabled = !loopEnabled;
      return updatePanel(interaction);
    }

    if (id === "btn_back15") { seekBy(-15); return updatePanel(interaction); }
    if (id === "btn_back60") { seekBy(-60); return updatePanel(interaction); }
    if (id === "btn_fwd60") { seekBy(60); return updatePanel(interaction); }
    if (id === "btn_fwd15") { seekBy(15); return updatePanel(interaction); }

    if (id === "btn_panel") {
      playlist = loadPlaylist();
      return updatePanel(interaction);
    }

    return;
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === "track_select") {
      if (!connection) {
        return interaction.reply({ content: "Press ▶ first to join voice channel.", flags: 64 });
      }
      const selected = parseInt(interaction.values[0]);
      playlist = loadPlaylist();
      if (selected < 0 || selected >= playlist.length) {
        return interaction.reply({ content: "Invalid track.", flags: 64 });
      }
      manualAction = true;
      player.stop();
      currentIndex = selected;
      resetTrackState();
      playTrack();
      return updatePanel(interaction);
    }

    if (interaction.customId === "playlist_switch") {
      currentPlaylistName = interaction.values[0];
      playlist = loadPlaylist();
      currentIndex = 0;
      if (connection && isPlaying) {
        manualAction = true;
        player.stop();
        resetTrackState();
        playTrack();
      }
      return updatePanel(interaction);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  if (commandName === "panel") {
    playlist = loadPlaylist();
    const webUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN
      : "https://discord-radio-bot-production.up.railway.app";
    const components = buildComponents();
    const webBtn = new ButtonBuilder().setLabel("🌐 Web Panel").setStyle(ButtonStyle.Link).setURL(webUrl);
    // add the web button to a row that has room (< 5 buttons), preferring index 1
    let added = false;
    for (let i = 0; i < components.length && !added; i++) {
      if (components[i].components.length < 5) {
        components[i] = new ActionRowBuilder().addComponents(...components[i].components, webBtn);
        added = true;
      }
    }
    if (!added && components.length < 5) {
      components.push(new ActionRowBuilder().addComponents(webBtn));
    }
    return interaction.reply({
      embeds: [buildPanelEmbed()], components, flags: 64,
    });
  }

  if (commandName === "add") {
    const attachment = interaction.options.getAttachment("file");
    if (!/\.(mp3|mp4|mkv|webm|ogg|wav)$/i.test(attachment.name)) {
      return interaction.reply({ content: "Unsupported format.", flags: 64 });
    }
    const target = interaction.options.getString("playlist") || currentPlaylistName;
    const dir = getPlaylistDir(target);
    if (!fs.existsSync(dir)) return interaction.reply({ content: `Playlist "${target}" does not exist.`, flags: 64 });
    await interaction.deferReply({ flags: 64 });
    try {
      const res = await fetch(attachment.url);
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(path.join(dir, attachment.name), buffer);
      playlist = loadPlaylist();
      return interaction.editReply(`Added **${attachment.name}** to "${target}" (${loadPlaylist(target).length} tracks).`);
    } catch (err) {
      return interaction.editReply("Failed: " + err.message);
    }
  }

  if (commandName === "addurl") {
    const url = interaction.options.getString("url");
    const target = interaction.options.getString("playlist") || currentPlaylistName;
    const dir = getPlaylistDir(target);
    if (!fs.existsSync(dir)) return interaction.reply({ content: `Playlist "${target}" does not exist.`, flags: 64 });
    await interaction.deferReply({ flags: 64 });
    try {
      const res = await fetch(url);
      if (!res.ok) return interaction.editReply("Failed to download: HTTP " + res.status);
      const contentType = res.headers.get("content-type") || "";
      let ext = ".mp3";
      const urlPath = new URL(url).pathname;
      const urlExt = path.extname(urlPath).toLowerCase();
      if (/\.(mp3|mp4|mkv|webm|ogg|wav)$/i.test(urlExt)) {
        ext = urlExt;
      } else if (contentType.includes("video")) {
        ext = ".mp4";
      } else if (contentType.includes("ogg")) {
        ext = ".ogg";
      } else if (contentType.includes("wav")) {
        ext = ".wav";
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      const name = path.basename(urlPath).replace(/[^a-zA-Z0-9._-]/g, "_").substring(0, 100) || "track";
      const filename = name.includes(".") ? name : name + ext;
      fs.writeFileSync(path.join(dir, filename), buffer);
      playlist = loadPlaylist();
      return interaction.editReply(`Downloaded **${filename}** (${(buffer.length / 1024 / 1024).toFixed(1)} MB) to "${target}" (${loadPlaylist(target).length} tracks).`);
    } catch (err) {
      return interaction.editReply("Failed to download: " + err.message);
    }
  }

  if (commandName === "createplaylist") {
    const name = interaction.options.getString("name").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!name) return interaction.reply({ content: "Invalid name.", flags: 64 });
    const dir = getPlaylistDir(name);
    if (fs.existsSync(dir)) return interaction.reply({ content: `"${name}" already exists.`, flags: 64 });
    fs.mkdirSync(dir, { recursive: true });
    return interaction.reply({ content: `Created playlist **"${name}"**.`, flags: 64 });
  }

  if (commandName === "deleteplaylist") {
    const name = interaction.options.getString("name").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (name === DEFAULT_PLAYLIST) return interaction.reply({ content: "Cannot delete default playlist.", flags: 64 });
    const dir = getPlaylistDir(name);
    if (!fs.existsSync(dir)) return interaction.reply({ content: `"${name}" does not exist.`, flags: 64 });
    fs.rmSync(dir, { recursive: true });
    if (currentPlaylistName === name) {
      currentPlaylistName = DEFAULT_PLAYLIST;
      playlist = loadPlaylist();
      currentIndex = 0;
    }
    return interaction.reply({ content: `Deleted **"${name}"**.`, flags: 64 });
  }

  if (commandName === "nowplaying") {
    if (!isPlaying || playlist.length === 0) {
      return interaction.reply({ content: "Nothing is playing.", flags: 64 });
    }
    return interaction.reply({ content: `Now playing: **${playlist[currentIndex]}** (${currentIndex + 1}/${playlist.length}) | Loop: ${loopEnabled ? "ON" : "OFF"}`, flags: 64 });
  }
});

async function main() {
  const sodium = require("libsodium-wrappers");
  await sodium.ready;
  console.log("Sodium ready.");
  client.login(token);
}

main();