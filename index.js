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
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime().toFixed(0) }));
  })
  .listen(PORT, () => console.log(`[web] keep-alive server on port ${PORT}`));

const { token } = require("./config.json");
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
let currentPlaylistName = DEFAULT_PLAYLIST;

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

function createMediaResource(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mp3" || ext === ".ogg" || ext === ".wav") {
    return createAudioResource(filePath);
  }
  const ffmpeg = spawn(process.env.FFMPEG_PATH, [
    "-i", filePath, "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1",
  ], { stdio: ["ignore", "pipe", "ignore"] });
  return createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
}

function playTrack() {
  if (!connection || playlist.length === 0) return;
  if (currentIndex >= playlist.length) currentIndex = 0;
  if (currentIndex < 0) currentIndex = playlist.length - 1;

  const file = playlist[currentIndex];
  const filePath = path.join(getPlaylistDir(currentPlaylistName), file);
  console.log(`[PLAY] ${file} (${currentIndex + 1}/${playlist.length})`);

  try {
    const resource = createMediaResource(filePath);
    resource.playStream.on("error", (e) => console.error("[STREAM ERROR]", e.message));
    player.play(resource);
    isPlaying = true;
    isStopped = false;
  } catch (err) {
    console.error("[PLAY ERROR]", err.message);
  }
}

player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });

player.on(AudioPlayerStatus.Playing, () => console.log("[PLAYER] PLAYING"));

player.on(AudioPlayerStatus.Idle, () => {
  console.log("[PLAYER] IDLE");
  if (manualAction) { manualAction = false; return; }
  if (isStopped) return;
  if (loopEnabled) {
    playTrack();
  } else {
    currentIndex++;
    playTrack();
  }
});

player.on("error", (error) => {
  console.error("[PLAYER ERROR]", error.message);
  currentIndex++;
  playTrack();
});

function buildPanelEmbed() {
  const current = playlist.length > 0 ? (playlist[currentIndex] || "None") : "No tracks";
  return new EmbedBuilder()
    .setColor(isPlaying ? 0x1DB954 : 0x99AAB5)
    .setTitle("Radio Control Panel")
    .setDescription(
      `**Status:** ${isPlaying ? "Playing" : isStopped ? "Stopped" : "Idle"}\n` +
      `**Now playing:** ${current}\n` +
      `**Track:** ${playlist.length > 0 ? currentIndex + 1 : 0}/${playlist.length}\n` +
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
        playTrack();
      }
      return updatePanel(interaction);
    }

    if (id === "btn_loop") {
      loopEnabled = !loopEnabled;
      return updatePanel(interaction);
    }

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
    return interaction.reply({
      embeds: [buildPanelEmbed()], components: buildComponents(), flags: 64,
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
