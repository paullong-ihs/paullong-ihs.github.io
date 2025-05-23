import express from "express";
import cors from "cors";
import fs from "fs/promises";
import { statSync, createReadStream } from "fs";
import path from "path";
import fg from "fast-glob";
import mm from "music-metadata";
import pLimit from "p-limit";

function resolveMusicRoot() {
  if (process.env.MUSIC_ROOT) return path.resolve(process.env.MUSIC_ROOT);
  const candidate = path.resolve(process.cwd(), "..", "music");
  try { if (statSync(candidate).isDirectory()) return candidate; } catch {}
  return path.resolve(process.cwd(), "music");
}

const MUSIC_ROOT = resolveMusicRoot();
const CATEGORIES = ["yedits", "personal"];
const CACHE_FILE = path.join(process.cwd(), "cache.json");
const PARALLEL = 4;
const AUDIO_GLOBS = ["**/*.{mp3,MP3,flac,FLAC,wav,WAV,ogg,OGG,m4a,M4A}"];

const app = express();
app.use(cors());
app.use(express.json());

let cache = {};
try { cache = JSON.parse(await fs.readFile(CACHE_FILE, "utf8")); } catch {}

async function scanCategory(cat) {
  const dir = path.join(MUSIC_ROOT, cat);
  const entries = await fg(AUDIO_GLOBS, { cwd: dir, onlyFiles: true, caseSensitiveMatch:false });
  const limit = pLimit(PARALLEL);
  const tracks = await Promise.all(entries.map(rel => limit(async () => {
    const filePath = path.join(dir, rel);
    const id = path.posix.join(cat, rel).replace(/\\/g, "/");
    if (cache[id]) return cache[id];
    const meta = await mm.parseFile(filePath, { duration:false });
    const { title, artist, album, year, genre } = meta.common;
    const ext = path.extname(rel).slice(1).toLowerCase();
    const track = {
      id, cat, rel,
      title: title || path.basename(rel, path.extname(rel)),
      artist: artist || "Unknown Artist",
      album: album || null,
      year: year || null,
      genre: genre && genre.length ? genre[0] : null,
      mimeType: ext==="flac"?"audio/flac": ext==="ogg"?"audio/ogg": ext==="wav"?"audio/wav": ext==="m4a"?"audio/mp4":"audio/mpeg",
      size: statSync(filePath).size
    };
    cache[id]=track;
    return track;
  })));
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache,null,2));
  return tracks;
}

let index = {};
async function buildIndex() {
  for (const cat of CATEGORIES) { index[cat] = await scanCategory(cat); }
  console.log("Music root:", MUSIC_ROOT, "|", CATEGORIES.map(c=>c+"="+index[c].length).join(", "));
}
await buildIndex();

app.get("/api/tracks/:cat", (req,res)=>{
  const { cat } = req.params;
  if (!CATEGORIES.includes(cat)) return res.status(404).send("No such category");
  res.json(index[cat]);
});

app.get("/api/stream/:cat/*", (req,res)=>{
  const { cat } = req.params;
  const rel = req.params[0];
  const id = path.posix.join(cat, rel);
  const track = cache[id];
  if (!track) return res.sendStatus(404);
  const filePath = path.join(MUSIC_ROOT, id);
  const { size } = statSync(filePath);
  const range = req.headers.range;
  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/,"").split("-");
    const start = parseInt(startStr,10);
    const end = endStr ? parseInt(endStr,10) : size-1;
    const chunk = end - start + 1;
    res.writeHead(206,{
      "Content-Range": "bytes "+start+"-"+end+"/"+size,
      "Accept-Ranges":"bytes",
      "Content-Length": chunk,
      "Content-Type": track.mimeType
    });
    createReadStream(filePath,{start,end}).pipe(res);
  } else {
    res.writeHead(200,{ "Content-Length": size, "Content-Type": track.mimeType });
    createReadStream(filePath).pipe(res);
  }
});

app.post("/api/rescan", async (req,res)=>{
  await buildIndex();
  res.json({ ok:true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, ()=> console.log("API ready at http://localhost:"+PORT));
