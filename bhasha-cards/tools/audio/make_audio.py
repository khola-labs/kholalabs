#!/usr/bin/env python3
"""Recorded pronunciations for Bhasha Cards (ElevenLabs eleven-v4 via fal, Gemini ASR check).

All fal calls go through the itihaas-v2 engine (ledger + HARD_STOP). No key ever lives in this repo.
Run with a numpy-capable python (/usr/bin/python3 on the mini).

  make_audio.py words   OUT.json                 # dump deduped built-in words per language (node)
  make_audio.py test    WORDS.json OUTDIR        # 5 sample words x candidate voices per language
  make_audio.py gen     WORDS.json WORK  [lang…] # batched TTS with timestamps -> WORK/<lang>/raw/*.wav
  make_audio.py qc      WORK [lang…]             # Gemini listen-check -> WORK/<lang>/qc.json, retakes
  make_audio.py encode  WORK AUDIO_DIR [lang…]   # mp3 + audio/<lang>.json manifests
  make_audio.py stats   WORK                     # QC summary table

Clip pipeline per word: cut by character timestamps -> trim silence -> drop isolated edge blips ->
RMS/peak normalise -> 24 kHz mono mp3 (48 kbps).
"""
import sys, os, re, json, time, pathlib, subprocess, hashlib, difflib, base64, urllib.request, concurrent.futures as cf
import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
APP = HERE.parent.parent                     # bhasha-cards/
ENGINE = "/opt/backup/workspace/personal/_pilot/itihaas-v2/engine"
ENV = pathlib.Path("/opt/backup/workspace/personal/income/.env")
sys.path.insert(0, ENGINE)

ENDPOINT = "fal-ai/elevenlabs/tts/eleven-v4"
JOB_PREFIX = "bhasha-cards audio"
JOB_CAP = 3.00                               # USD, whole task, across all notes with JOB_PREFIX
VOICES = {                                    # ElevenLabs voice ids already used by Khola Labs
    "monika": "1qEiC6qsybMkmnNdVMbK",          # Monika Sogam, Hindi, verified in 24 languages
    "gaurav": "SXuKWBhKoIoAHKlf6Gt3",          # Gaurav, Indian English male
    "raqib":  "0UZ29F1kNDvmelKG8QCM",          # Raqib, Hindi male
}
LANG_CODE = {"hi": "hi", "mr": "mr", "gu": "gu", "pa": "pa", "ta": "ta", "te": "te", "bn": "bn", "en": "en"}
LANG_NAME = {"hi": "Hindi", "mr": "Marathi", "gu": "Gujarati", "pa": "Punjabi (Gurmukhi)", "ta": "Tamil", "te": "Telugu", "bn": "Bengali", "en": "English"}
# Chosen Nov 13 2026 after a 5-word x 3-voice test per language: Gemini ASR (all three ~40/40) + Gemini 2.5 Pro listening
# judge for warmth / native accent / child-friendliness (see _review/2026-11-13-bhasha-cards-audio/REPORT.md).
VOICE_FOR = {"hi": "raqib", "gu": "raqib", "ta": "raqib", "te": "raqib", "bn": "raqib", "mr": "gaurav", "pa": "gaurav", "en": "monika"}
SPEED = 0.92                                  # a touch slower for kids
BATCH = 16                                    # words per TTS request
SR = 44100
GEMINI_MODEL = "gemini-2.5-flash"

# ---------------------------------------------------------------- fal
def fal():
    import fal as f; return f
def job_spent():
    f = fal()
    if not f.SPEND.exists(): return 0.0
    return sum(c["est_usd"] for c in json.loads(f.SPEND.read_text())["calls"] if c.get("note", "").startswith(JOB_PREFIX))
def est_cost(text): return round(len(text) / 1000 * 0.08 + 0.005, 4)
def clean(s): return re.sub(r'[“”"\'‘’*]', "", s).strip()
def tts(text, voice_id, lang, note, stability=0.55):
    """One eleven-v4 request with timestamps. Returns (mp3 bytes, [(char, start, end), …])."""
    est = est_cost(text)
    if job_spent() + est > JOB_CAP: raise SystemExit(f"JOB CAP: {job_spent():.3f}+{est} > {JOB_CAP}")
    payload = {"text": text, "voice": voice_id, "stability": stability, "similarity_boost": 0.8, "speed": SPEED,
               "timestamps": True, "language_code": LANG_CODE[lang]}
    r = fal().run(ENDPOINT, payload, est, f"{JOB_PREFIX} {note} ({len(text)} chars)")
    with urllib.request.urlopen(r["audio"]["url"], timeout=120) as u: mp3 = u.read()
    chars = []
    for seg in r.get("timestamps") or []:
        for ch, a, b in zip(seg["characters"], seg["character_start_times_seconds"], seg["character_end_times_seconds"]):
            chars.append((ch, a, b))
    return mp3, chars

# ---------------------------------------------------------------- audio helpers
def decode(data_or_path):
    inp = ["-i", "pipe:0"] if isinstance(data_or_path, (bytes, bytearray)) else ["-i", str(data_or_path)]
    p = subprocess.run(["ffmpeg", "-v", "error", "-threads", "2", *inp, "-f", "f32le", "-ac", "1", "-ar", str(SR), "pipe:1"],
                       input=data_or_path if isinstance(data_or_path, (bytes, bytearray)) else None, capture_output=True, check=True)
    return np.frombuffer(p.stdout, dtype=np.float32).copy()
def write_wav(x, path):
    pathlib.Path(path).parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "pipe:0", str(path)],
                   input=x.astype(np.float32).tobytes(), check=True)
def to_mp3(wav, mp3, kbps=48, ar=24000):
    pathlib.Path(mp3).parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-threads", "2", "-i", str(wav), "-ac", "1", "-ar", str(ar), "-c:a", "libmp3lame",
                    "-b:a", f"{kbps}k", "-id3v2_version", "0", "-write_xing", "1", str(mp3)], check=True)

def frames_db(x, hop=0.01):
    n = max(1, int(SR * hop)); m = len(x) // n
    if m == 0: return np.array([-100.0]), n
    e = np.sqrt(np.mean(x[:m * n].reshape(m, n) ** 2, axis=1) + 1e-12)
    return 20 * np.log10(e + 1e-9), n

def regions(db, thr, n):
    """voiced regions [(start_frame, end_frame)] above thr, merging gaps < 50 ms."""
    v = db > thr; out = []; i = 0
    while i < len(v):
        if v[i]:
            j = i
            while j < len(v) and v[j]: j += 1
            out.append([i, j]); i = j
        else: i += 1
    merged = []
    for a, b in out:
        if merged and (a - merged[-1][1]) * n / SR < 0.05: merged[-1][1] = b
        else: merged.append([a, b])
    return merged

def clean_clip(x, span=None, blips=True):
    """Trim silence, drop isolated edge blips, normalise. span=(start,end) seconds of the word inside x
    (from the TTS character timestamps): only audio outside the span can be a stray blip."""
    info = {"in_s": round(len(x) / SR, 3), "dropped": []}
    x = x - np.mean(x)
    db, n = frames_db(x)
    peak_db = float(db.max()); thr = max(peak_db - 35, -55)
    reg = regions(db, thr, n)
    if not reg: return None, {**info, "err": "silent"}
    dur = lambda r: (r[1] - r[0]) * n / SR
    # stray blips ("ss"/"mm" fragments of a neighbour, clicks) at head/tail: an isolated region (gap >= 60 ms to the body)
    # that lies outside the word's own timestamp span (+-80 ms tolerance), or is short AND >= 15 dB quieter than the body.
    sec = lambda f: f * n / SR
    pk = lambda r: float(db[r[0]:r[1]].max())
    body_pk = max(pk(r) for r in reg)
    s0, s1 = (span if span else (0.0, len(x) / SR))
    def stray(r, edge, gap):
        # wide tolerance: ElevenLabs char timings miss final stop releases (saat, daant) and affricate onsets (chair) by ~0.1 s
        outside = (sec(r[1]) < s0 - 0.15) if edge == "head" else (sec(r[0]) > s1 + 0.15)
        # a final stop release is also short and quiet but sits within ~0.1 s of the vowel: only call a quiet
        # fragment stray when it is further away than any closure gap
        quiet = gap >= 0.12 and dur(r) < 0.08 and pk(r) < body_pk - 15
        return blips and (outside or quiet)
    while len(reg) > 1 and sec(reg[1][0] - reg[0][1]) >= 0.06 and stray(reg[0], "head", sec(reg[1][0] - reg[0][1])):
        info["dropped"].append(("head", round(float(dur(reg[0])), 3))); reg.pop(0)
    while len(reg) > 1 and sec(reg[-1][0] - reg[-2][1]) >= 0.06 and stray(reg[-1], "tail", sec(reg[-1][0] - reg[-2][1])):
        info["dropped"].append(("tail", round(float(dur(reg[-1])), 3))); reg.pop()
    a = max(0, int(reg[0][0] * n - 0.04 * SR)); b = min(len(x), int(reg[-1][1] * n + 0.14 * SR))
    y = x[a:b].copy()
    # fades
    fi, fo = int(0.006 * SR), int(0.03 * SR)
    if len(y) > fi + fo:
        y[:fi] *= np.linspace(0, 1, fi); y[-fo:] *= np.linspace(1, 0, fo)
    # normalise: RMS of voiced part -> -20 dBFS, peak <= -1 dBFS
    vdb, _ = frames_db(y); voiced = y[: (len(vdb)) * n].reshape(len(vdb), n)[vdb > thr]
    rms = np.sqrt(np.mean(voiced ** 2)) if voiced.size else np.sqrt(np.mean(y ** 2))
    g = min(10 ** (-20 / 20) / max(rms, 1e-6), 10 ** (-1 / 20) / max(np.abs(y).max(), 1e-6))
    y *= g
    info.update(out_s=round(len(y) / SR, 3), gain_db=round(float(20 * np.log10(g)), 1), peak_db=round(float(peak_db), 1))
    return y, info

# ---------------------------------------------------------------- words
def slug(word, translit, meaning):
    base = translit or meaning or word
    base = re.sub(r"[^a-z0-9]+", "-", base.lower()).strip("-")[:28] or "w"
    return f"{base}-{hashlib.sha1(word.encode()).hexdigest()[:6]}"

def batch_text(words):
    """Carrier: each word as its own short sentence on its own line -> falling intonation + clean gaps."""
    return "\n".join(clean(w) + "." for w in words)

def align(chars, words):
    """Map each word to (start, end) seconds using the per-character timestamps."""
    s = "".join(c for c, _, _ in chars); pos = 0; spans = []
    for w in words:
        w = clean(w); i = s.find(w, pos)
        if i < 0:   # normalisation changed the text: fuzzy locate
            m = difflib.SequenceMatcher(None, s[pos:], w).find_longest_match(0, len(s) - pos, 0, len(w))
            if m.size < max(2, len(w) // 2): spans.append(None); continue
            i = pos + m.a - m.b
        j = i + len(w)
        spans.append((chars[i][1], chars[min(j, len(chars)) - 1][2])); pos = j
    return spans

def cut_words(x, chars, words):
    """Returns list of numpy clips (or None) for words in the batch."""
    spans = align(chars, words); out = []
    for k, sp in enumerate(spans):
        if not sp: out.append(None); continue
        a, b = sp
        prev_end = spans[k - 1][1] if k and spans[k - 1] else 0.0
        next_start = spans[k + 1][0] if k + 1 < len(spans) and spans[k + 1] else len(x) / SR
        w0, w1 = a, b
        a = max(a - 0.18, (a + prev_end) / 2 if k else 0.0)
        b = min(b + 0.35, (b + next_start) / 2 if k + 1 < len(spans) else len(x) / SR)
        out.append((x[int(a * SR):int(b * SR)], (w0 - a, w1 - a)))
    return out

# ---------------------------------------------------------------- Gemini ASR
def gkey():
    for l in ENV.read_text().splitlines():
        m = re.match(r"\s*(?:export\s+)?GEMINI_NANO_BANANA_API_KEY\s*=\s*[\"']?([^\"'\s]+)", l)
        if m: return m.group(1)
    raise SystemExit("no Gemini key")
def listen(path, lang, target, k):
    q = (f"You will hear a very short audio clip (about one second) of a single {LANG_NAME[lang]} word, spoken by a text-to-speech voice "
         f"for a children's flashcard app. First transcribe exactly what you hear in the native script"
         f"{' (Latin letters)' if lang == 'en' else ''}; do not guess from context. Then compare with the intended word: {target}. "
         "Judge match=true if a native-speaking parent would accept it as that word (small accent/dialect differences are fine; "
         "a different word, a missing syllable, or an extra syllable are not). Also report defects: a cut-off start or end, a stray "
         "click/hiss/hum blip before or after the word, or two words spoken. "
         'Reply ONLY JSON: {"heard":"…","match":true|false,"clarity":1-5,"defect":"none"|"<short>"}')
    body = {"contents": [{"parts": [{"text": q}, {"inline_data": {"mime_type": "audio/mpeg", "data": base64.b64encode(pathlib.Path(path).read_bytes()).decode()}}]}],
            "generationConfig": {"response_mime_type": "application/json", "temperature": 0}}
    req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent",
                                 data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "x-goog-api-key": k})
    for attempt in range(4):
        try:
            r = json.load(urllib.request.urlopen(req, timeout=90))
            u = r.get("usageMetadata", {})
            v = json.loads(r["candidates"][0]["content"]["parts"][0]["text"])
            v["tokens"] = u.get("totalTokenCount", 0); return v
        except Exception as e:
            err = str(e); time.sleep(3 * (attempt + 1))
    return {"heard": "", "match": False, "clarity": 0, "defect": "gemini error " + err[:80], "tokens": 0}

def norm(s): return re.sub(r"[\s\.\,\!\?।॥\-'’]+", "", (s or "").lower())
def text_match(a, b):
    a, b = norm(a), norm(b)
    return a == b or (len(a) > 2 and difflib.SequenceMatcher(None, a, b).ratio() >= 0.8)

# ---------------------------------------------------------------- commands
def cmd_words(out):
    js = HERE / "extract.mjs"
    subprocess.run(["node", str(js), out], check=True)

def cmd_test(words_json, outdir):
    """5 sample words per language x candidate voices, through the real pipeline, + Gemini verdicts."""
    W = json.load(open(words_json)); out = pathlib.Path(outdir); out.mkdir(parents=True, exist_ok=True); k = gkey()
    picks = {"hi": ["माँ", "खरगोश", "छिपकली", "धन्यवाद", "सात"], "mr": ["आई", "ससा", "फुलपाखरू", "धन्यवाद", "सात"],
             "gu": ["મમ્મી", "સસલું", "પતંગિયું", "આભાર", "સાત"], "pa": ["ਮੰਮੀ", "ਖਰਗੋਸ਼", "ਤਿਤਲੀ", "ਧੰਨਵਾਦ", "ਸੱਤ"],
             "ta": ["அம்மா", "முயல்", "பட்டாம்பூச்சி", "நன்றி", "ஏழு"], "te": ["అమ్మ", "కుందేలు", "సీతాకోకచిలుక", "ధన్యవాదాలు", "ఏడు"],
             "bn": ["মা", "খরগোশ", "প্রজাপতি", "ধন্যবাদ", "সাত"], "en": ["Mother", "Rabbit", "Butterfly", "Thank you", "Seven"]}
    results = {}
    if os.environ.get("TEST_LANGS"): picks = {l: picks[l] for l in os.environ["TEST_LANGS"].split(",")}
    voices = {k: v for k, v in VOICES.items() if not os.environ.get("TEST_VOICES") or k in os.environ["TEST_VOICES"].split(",")}
    for lang, ws in picks.items():
        have = {w["word"]: w for w in W[lang]}
        ws = [w for w in ws if w in have] or [w["word"] for w in W[lang][:5]]
        ws = (ws + [w["word"] for w in W[lang] if w["word"] not in ws])[:5]
        for vn, vid in voices.items():
            text = batch_text(ws)
            try: mp3, chars = tts(text, vid, lang, f"test {lang} {vn}")
            except SystemExit: raise
            except Exception as e: print("ERR", lang, vn, e); continue
            x = decode(mp3); d = out / lang; d.mkdir(exist_ok=True)
            (d / f"{vn}_batch.mp3").write_bytes(mp3)
            for w, cut in zip(ws, cut_words(x, chars, ws)):
                if cut is None: results[f"{lang}/{vn}/{w}"] = {"err": "align"}; continue
                y, info = clean_clip(*cut)
                if y is None: results[f"{lang}/{vn}/{w}"] = info; continue
                wav = d / f"{vn}_{slug(w, have[w]['translit'], have[w]['meaning'])}.wav"; write_wav(y, wav)
                mp3p = wav.with_suffix(".mp3"); to_mp3(wav, mp3p); wav.unlink()
                v = listen(mp3p, lang, w, k); v["info"] = info; results[f"{lang}/{vn}/{w}"] = v
                print(f"{lang} {vn:7} {w:14} heard={v.get('heard','')!s:16} match={v.get('match')} clar={v.get('clarity')} def={v.get('defect')} {info.get('out_s')}s drop={info.get('dropped')}", flush=True)
    json.dump(results, open(out / "test_results.json", "w"), ensure_ascii=False, indent=1)
    # summary
    print("\nvoice  lang  match  clarity  defects")
    for lang in picks:
        for vn in voices:
            rs = [v for kk, v in results.items() if kk.startswith(f"{lang}/{vn}/") and "match" in v]
            if rs: print(f"{vn:7}{lang:5} {sum(v['match'] for v in rs)}/{len(rs)}   {np.mean([v['clarity'] for v in rs]):.1f}     {sum(v['defect']!='none' for v in rs)}")
    print("fal job spent", round(job_spent(), 3))

def cmd_gen(words_json, work, langs):
    W = json.load(open(words_json)); work = pathlib.Path(work)
    for lang in langs or list(LANG_CODE):
        d = work / lang; raw = d / "raw"; raw.mkdir(parents=True, exist_ok=True)
        meta_p = d / "clips.json"; meta = json.load(open(meta_p)) if meta_p.exists() else {}
        todo = [w for w in W[lang] if w["word"] not in meta]
        print(lang, "todo", len(todo), "of", len(W[lang]), flush=True)
        for bi in range(0, len(todo), BATCH):
            group = todo[bi:bi + BATCH]; ws = [w["word"] for w in group]
            mp3, chars = tts(batch_text(ws), VOICES[VOICE_FOR[lang]], lang, f"gen {lang} b{bi // BATCH}")
            (d / f"batch_{bi // BATCH:02d}.mp3").write_bytes(mp3)
            json.dump({"words": ws, "chars": chars}, open(d / f"batch_{bi // BATCH:02d}.json", "w"), ensure_ascii=False)
            x = decode(mp3)
            for w, cut in zip(group, cut_words(x, chars, ws)):
                s = slug(w["word"], w["translit"], w["meaning"]); rec = {"slug": s, "translit": w["translit"], "meaning": w["meaning"], "takes": 1, "status": "raw"}
                if cut is None: rec["status"] = "align_fail"; meta[w["word"]] = rec; continue
                y, info = clean_clip(*cut)
                if y is None: rec["status"] = "silent"; meta[w["word"]] = rec; continue
                write_wav(y, raw / f"{s}.wav"); rec["info"] = info; meta[w["word"]] = rec
            json.dump(meta, open(meta_p, "w"), ensure_ascii=False, indent=1)
            print(f"  batch {bi // BATCH} ok  job ${job_spent():.3f}", flush=True)

def retake(lang, word, rec, d):
    """Single-word retake (still carrier style: word on its own line with a full stop)."""
    mp3, chars = tts(batch_text([word]), VOICES[VOICE_FOR[lang]], lang, f"retake {lang} {rec['slug']} t{rec['takes'] + 1}", stability=[0.55, 0.7, 0.4][rec["takes"] % 3])
    x = decode(mp3); cut = cut_words(x, chars, [word])[0] or (x, None)
    y, info = clean_clip(*cut); rec["takes"] += 1
    if y is None: return False
    write_wav(y, d / "raw" / f"{rec['slug']}.wav"); rec["info"] = info; return True

def cmd_qc(work, langs, max_takes=3):
    work = pathlib.Path(work); k = gkey()
    for lang in langs or list(LANG_CODE):
        d = work / lang; meta_p = d / "clips.json"
        if not meta_p.exists(): continue
        meta = json.load(open(meta_p)); tmp = d / "tmp"; tmp.mkdir(exist_ok=True)
        def check(word):
            rec = meta[word]; wav = d / "raw" / f"{rec['slug']}.wav"
            if not wav.exists(): return word, None
            m = tmp / f"{rec['slug']}.mp3"; to_mp3(wav, m)
            return word, listen(m, lang, word, k)
        pending = [w for w, r in meta.items() if r["status"] in ("raw", "retry")]
        rnd = 0
        while pending and rnd < max_takes:
            rnd += 1; print(f"{lang} qc round {rnd}: {len(pending)} clips", flush=True)
            with cf.ThreadPoolExecutor(4) as ex:
                for word, v in ex.map(check, pending):
                    rec = meta[word]
                    if v is None: rec["status"] = "missing"; continue
                    rec.setdefault("qc", []).append({"heard": v.get("heard"), "match": v.get("match"), "clarity": v.get("clarity"), "defect": v.get("defect"), "tok": v.get("tokens")})
                    ok_text = text_match(v.get("heard", ""), word)
                    bad_defect = v.get("defect", "none") not in ("none", "", None) and re.search(r"cut|clip|blip|click|hiss|hum|two|extra|missing|trunc|abrupt", str(v.get("defect")), re.I)
                    if (v.get("match") or ok_text) and not bad_defect and (v.get("clarity") or 0) >= 3: rec["status"] = "ok"
                    elif rec["takes"] >= max_takes: rec["status"] = "flag"
                    else: rec["status"] = "retry"
                json.dump(meta, open(meta_p, "w"), ensure_ascii=False, indent=1)
            retries = [] if os.environ.get("QC_NO_RETAKE") else [w for w, r in meta.items() if r["status"] == "retry"]
            for w in retries:
                print(f"  retake {w} ({meta[w]['slug']}) heard={meta[w]['qc'][-1]['heard']!r} defect={meta[w]['qc'][-1]['defect']}", flush=True)
                try:
                    if not retake(lang, w, meta[w], d): meta[w]["status"] = "flag"
                except SystemExit: raise
                except Exception as e: print("  retake error", e); meta[w]["status"] = "flag"
            json.dump(meta, open(meta_p, "w"), ensure_ascii=False, indent=1)
            pending = [w for w, r in meta.items() if r["status"] == "retry"]
        n = len(meta); ok = sum(r["status"] == "ok" for r in meta.values())
        print(f"{lang}: {ok}/{n} ok, flagged {[w for w, r in meta.items() if r['status'] == 'flag']}", flush=True)

def cmd_encode(work, audio_dir, langs):
    work = pathlib.Path(work); audio = pathlib.Path(audio_dir); total = 0; size = 0
    for lang in langs or list(LANG_CODE):
        d = work / lang; meta_p = d / "clips.json"
        if not meta_p.exists(): continue
        meta = json.load(open(meta_p)); man = {}
        (audio / lang).mkdir(parents=True, exist_ok=True)
        for word, rec in meta.items():
            wav = d / "raw" / f"{rec['slug']}.wav"
            if rec["status"] not in ("ok", "flag") or not wav.exists(): continue   # flagged clips still ship (best take); listed in REPORT
            out = audio / lang / f"{rec['slug']}.mp3"; to_mp3(wav, out); man[word] = rec["slug"]
            total += 1; size += out.stat().st_size
        json.dump(man, open(audio / f"{lang}.json", "w"), ensure_ascii=False, separators=(",", ":"))
        print(lang, len(man), "clips", flush=True)
    print("total", total, "clips", round(size / 1e6, 2), "MB")

def cmd_stats(work):
    work = pathlib.Path(work); rows = []
    for lang in LANG_CODE:
        p = work / lang / "clips.json"
        if not p.exists(): continue
        m = json.load(open(p)); st = {}
        for r in m.values(): st[r["status"]] = st.get(r["status"], 0) + 1
        takes = sum(r["takes"] for r in m.values()); first = sum(1 for r in m.values() if r["status"] == "ok" and r["takes"] == 1)
        flags = [f"{w} ({r['slug']}: heard {r['qc'][-1]['heard']!r}, {r['qc'][-1]['defect']})" for w, r in m.items() if r["status"] == "flag"]
        tok = sum(q.get("tok", 0) or 0 for r in m.values() for q in r.get("qc", []))
        rows.append((lang, len(m), st, first, takes, flags, tok))
        print(f"{lang}: {len(m)} words | {st} | first-take ok {first} | TTS takes {takes} | gemini tokens {tok}")
        for f in flags: print("   FLAG", f)
    print("fal job spent $", round(job_spent(), 3))
    return rows

if __name__ == "__main__":
    a = sys.argv[1:]
    if not a: sys.exit(__doc__)
    c = a[0]
    if c == "words": cmd_words(a[1])
    elif c == "test": cmd_test(a[1], a[2])
    elif c == "gen": cmd_gen(a[1], a[2], a[3:])
    elif c == "qc": cmd_qc(a[1], a[2:])
    elif c == "encode": cmd_encode(a[1], a[2], a[3:])
    elif c == "stats": cmd_stats(a[1])
    else: sys.exit(__doc__)
