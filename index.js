import { createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, appendFileSync, writeFileSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

/**
 * Fairy Ⅲ · H.D.D Skin — Host half.
 *
 *   GET  /dsh-fairy-zzz-for-jediliu/assets/<file>   boot.mp4 / poster.jpg / hero.png / voice/greet-*.wav
 *   GET  /dsh-fairy-zzz-for-jediliu/audio/<hash>.wav synthesized voice cache (Range capable)
 *   POST /dsh-fairy-zzz-for-jediliu/tts             { text } -> { url, cached, seconds }
 *   GET  /dsh-fairy-zzz-for-jediliu/mood            { mood } -> idle | thinking | working | done
 *   GET  /dsh-fairy-zzz-for-jediliu/voice-home      { ok, home, source, reason }
 *   POST /dsh-fairy-zzz-for-jediliu/voice-home      { home, probe? } -> 保存/校验引擎目录
 *   GET  /dsh-fairy-zzz-for-jediliu/engine          { phase, home, error } -> 本地语音引擎状态
 *   POST /dsh-fairy-zzz-for-jediliu/engine          { action: 'start' | 'stop' }
 *   GET  /dsh-fairy-zzz-for-jediliu/health          { ok, engine, voice }
 *
 * The Client half owns every pixel; this half owns bytes, cache and the local
 * GPT-SoVITS process (already resident on 127.0.0.1:9800 in the usual case).
 */

/** 朗读摘要用的模型配置（不含敏感信息时返回空对象）。 */
const SUMMARY_CONFIG = resolve(homedir(), '.dsh', 'fairy-tts.json')

function loadSummaryConfig() {
  try {
    const raw = readFileSync(SUMMARY_CONFIG, 'utf8')
    const data = JSON.parse(raw)
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

/**
 * 调用模型把长文本压成一句中文结论。
 *
 * @param {string} text 原始回复文本。
 * @returns {Promise<string>} 不超过 120 字的中文结论。
 */
async function summarizeText(text) {
  const config = loadSummaryConfig()
  const apiKey = process.env.DEEPSEEK_API_KEY || config.apiKey || ''
  if (!apiKey) throw new Error('missing deepseek api key')
  const baseUrl = String(config.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '')
  const model = String(config.model || 'deepseek-chat')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              '你是朗读摘要器。把用户给的内容压缩成一句中文结论，不超过40个字，只输出这句话本身：不要引号、不要解释、不要前缀。',
          },
          { role: 'user', content: text },
        ],
        max_tokens: 120,
        temperature: 0.2,
        stream: false,
      }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`http ${response.status}`)
    const data = await response.json()
    const raw = String(data?.choices?.[0]?.message?.content || '')
    const cleaned = raw
      .replace(/^[\s"'“「『]+/, '')
      .replace(/[\s"'”」』]+$/, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!cleaned) throw new Error('empty summary')
    return cleaned.slice(0, 120)
  } finally {
    clearTimeout(timer)
  }
}

/* ---- 朗读摘要限流（内存级滑窗，20 次/分钟） ---- */
const summarizeHits = []
function summarizeAllowed() {
  const now = Date.now()
  const window = 60 * 1000
  while (summarizeHits.length && now - summarizeHits[0] > window) summarizeHits.shift()
  if (summarizeHits.length >= 20) return false
  summarizeHits.push(now)
  return true
}

/* ---- TTS 缓存：总量或条数超限时，从最旧开始清 ---- */
const CACHE_MAX_BYTES = 100 * 1024 * 1024
const CACHE_MAX_FILES = 200

function pruneCache() {
  try {
    const entries = readdirSync(CACHE)
      .map((n) => {
        const path = join(CACHE, n)
        try {
          const info = statSync(path)
          return { path, size: info.size, mtime: info.mtimeMs }
        } catch {
          return null
        }
      })
      .filter(Boolean)
    let total = entries.reduce((sum, e) => sum + e.size, 0)
    entries.sort((a, b) => a.mtime - b.mtime)
    let i = 0
    while ((total > CACHE_MAX_BYTES || entries.length - i > CACHE_MAX_FILES) && i < entries.length) {
      const item = entries[i]
      i += 1
      total -= item.size
      try {
        rmSync(item.path)
      } catch {}
    }
  } catch {}
}

/* ---- 问候语：只保留最近 7 天 ---- */
const GREET_KEEP_DAYS = 7

function pruneGreetings() {
  try {
    const cutoff = new Date(Date.now() - GREET_KEEP_DAYS * 86400 * 1000)
    const names = readdirSync(GREET_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
    for (const name of names) {
      const day = new Date(`${name}T00:00:00`)
      if (Number.isNaN(day.getTime()) || day < cutoff) {
        try {
          rmSync(join(GREET_DIR, name), { recursive: true, force: true })
        } catch {}
      }
    }
  } catch {}
}

export const name = 'dsh-fairy-zzz-for-jediliu'
export const inject = ['webServer']

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ASSETS = join(HERE, 'assets')
const CACHE = process.env.FAIRY_CACHE_DIR || join(HERE, 'cache')

const TTS_PORT = Number(process.env.FAIRY_TTS_PORT || 9800)

/* 语音引擎位置由用户自己指定，优先级：
   1. voice-home.txt（设置面板里填的目录，与插件同目录）—— 用户选择永远优先
   2. FAIRY_VOICE_HOME 环境变量（安装脚本 / 进阶用户）
   3. 插件同级 voice/（免安装便携包自带引擎）
   4. 旧版 FAIRY_TTS_DIR 环境变量（兼容早期安装）
   都没有就返回空串：皮肤照常工作，只是不朗读，设置面板会提示去指定目录。
   （问候语是预录 wav，不依赖引擎。） */
const VOICE_HINT = join(HERE, 'voice-home.txt')

function readVoiceHome() {
  try {
    const hint = readFileSync(VOICE_HINT, 'utf8').trim()
    if (hint) return resolve(hint)
  } catch {}
  if (process.env.FAIRY_VOICE_HOME) return resolve(process.env.FAIRY_VOICE_HOME)
  const beside = join(HERE, '..', 'voice')
  if (existsSync(join(beside, 'fairy_server.py'))) return resolve(beside)
  if (process.env.FAIRY_TTS_DIR) return resolve(process.env.FAIRY_TTS_DIR)
  return ''
}

function voiceHomeSource() {
  try {
    if (readFileSync(VOICE_HINT, 'utf8').trim()) return 'settings'
  } catch {}
  if (process.env.FAIRY_VOICE_HOME) return 'env'
  if (existsSync(join(HERE, '..', 'voice', 'fairy_server.py'))) return 'portable'
  if (process.env.FAIRY_TTS_DIR) return 'legacy'
  return 'none'
}

/* 用户填进来的路径：去引号、合并重复分隔符，Windows 下统一成反斜杠。 */
const IS_WIN = process.platform === 'win32'

function cleanHome(value) {
  let out = String(value ?? '')
    .trim()
    .replace(/^"+|"+$/g, '')
    .replace(/([\\/])\1+/g, '$1')
  if (IS_WIN) out = out.replace(/\//g, '\\')
  return out
}

/* 检查一个目录是不是能跑起来的语音引擎，返回可读的诊断。 */
function inspectVoiceDir(dir) {
  const empty = { ok: false, home: '', source: voiceHomeSource(), reason: '' }
  if (!dir) return { ...empty, reason: '还没有指定语音引擎目录' }
  if (!existsSync(dir)) return { ...empty, home: dir, reason: '目录不存在：' + dir }
  const server = join(dir, 'fairy_server.py')
  if (!existsSync(server)) return { ...empty, home: dir, reason: '目录里没有 fairy_server.py' }
  const python = resolvePython(dir)
  if (!existsSync(python)) return { ...empty, home: dir, reason: '目录里没有 python\\python.exe 或 py311\\python.exe' }
  if (!existsSync(join(dir, 'GPT-SoVITS'))) return { ...empty, home: dir, reason: '目录里没有 GPT-SoVITS' }
  return {
    ok: true,
    home: dir,
    source: voiceHomeSource(),
    python,
    server,
    models: existsSync(join(dir, 'models')) ? join(dir, 'models') : '',
    reason: '',
  }
}

function saveVoiceHome(dir) {
  const clean = cleanHome(dir)
  const info = inspectVoiceDir(clean)
  if (!info.ok) return info
  try {
    writeFileSync(VOICE_HINT, clean + '\n', 'utf8')
  } catch (cause) {
    return { ...info, ok: false, reason: '写不进 voice-home.txt：' + String(cause?.message ?? cause) }
  }
  syncVoiceHome()
  return { ...inspectVoiceDir(clean), source: 'settings', saved: true }
}

let TTS_DIR = readVoiceHome()
let TTS_PY = resolvePython(TTS_DIR)
let TTS_SERVER = join(TTS_DIR, 'fairy_server.py')

function resolvePython(dir) {
  if (!dir) return ''
  return existsSync(join(dir, 'python', 'python.exe'))
    ? join(dir, 'python', 'python.exe')
    : join(dir, 'py311', 'python.exe')
}

/* 每次用到引擎前重新解析一次：改了环境变量 / voice-home.txt 之后
   不必重启宿主，下一次请求就会指向新目录。 */
function syncVoiceHome() {
  let dir = ''
  try {
    dir = readVoiceHome()
  } catch {
    return
  }
  if (dir === TTS_DIR) return
  TTS_DIR = dir
  TTS_PY = resolvePython(dir)
  TTS_SERVER = join(dir, 'fairy_server.py')
}
const TTS_SPEED = 1.04
const MAX_CHARS = 500

const MIME = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
}

const mimeOf = (file) => MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'

async function sizeOf(file) {
  try {
    const info = await stat(file)
    return info.isFile() ? info.size : -1
  } catch {
    return -1
  }
}

async function sendFile(req, res, file) {
  const total = await sizeOf(file)
  if (total < 0) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  const type = mimeOf(file)
  const range = req.headers.range
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (match) {
      const start = match[1] ? Number(match[1]) : 0
      const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1
      if (start <= end && start < total) {
        res.writeHead(206, {
          'content-type': type,
          'content-range': `bytes ${start}-${end}/${total}`,
          'accept-ranges': 'bytes',
          'content-length': end - start + 1,
          'cache-control': 'no-cache',
        })
        createReadStream(file, { start, end }).pipe(res)
        return
      }
    }
  }
  res.writeHead(200, {
    'content-type': type,
    'accept-ranges': 'bytes',
    'content-length': total,
    'cache-control': 'no-cache',
  })
  createReadStream(file).pipe(res)
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((done, fail) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        fail(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')))
    req.on('error', fail)
  })
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function engineState() {
  try {
    const res = await fetch(`http://127.0.0.1:${TTS_PORT}/health`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return { up: false, loading: false, ready: false, error: '', state: 'dead' }
    const data = await res.json().catch(() => ({}))
    const loading = Boolean(data?.loading)
    const ready = Boolean(data?.ready)
    return { up: true, loading, ready, error: String(data?.error ?? ''), state: ready ? 'ready' : loading ? 'loading' : 'error' }
  } catch {
    return { up: false, loading: false, ready: false, error: '', state: 'dead' }
  }
}

async function pingEngine() {
  return (await engineState()).up
}

let enginePromise = null
let engineChild = null

function ensureEngine() {
  syncVoiceHome()
  if (!enginePromise) {
    enginePromise = (async () => {
      const state = await engineState()
      if (state.up) return true
      if (!existsSync(TTS_PY) || !existsSync(TTS_SERVER)) {
        throw new Error(TTS_DIR ? `语音引擎不完整：${TTS_DIR}（请在 设置 → Fairy 里重新指定目录）` : '还没有指定语音引擎目录（设置 → Fairy → 语音引擎目录）')
      }
      const logFile = join(TTS_DIR, 'server.log')
      let out = 'ignore'
      try {
        out = openSync(logFile, 'a')
      } catch {}
      const child = spawn(TTS_PY, [TTS_SERVER, '--port', String(TTS_PORT)], {
        detached: true,
        stdio: ['ignore', out, out],
        cwd: TTS_DIR,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })
      child.unref()
      engineChild = child
      for (let tick = 0; tick < 180; tick += 1) {
        await sleep(1000)
        const now = await engineState()
        if (now.up) return true
        if (child.exitCode !== null && child.exitCode !== undefined) break
      }
      throw new Error('语音引擎启动超时（日志见 voice/server.log）')
    })().catch((cause) => {
      enginePromise = null
      throw cause
    })
  }
  return enginePromise
}

async function stopEngine() {
  enginePromise = null
  const child = engineChild
  engineChild = null
  if (!child) return false
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    } else {
      child.kill('SIGTERM')
    }
    return true
  } catch {
    return false
  }
}

/** CPU 推理排队：一次只跑一句，跟引擎保持一致。 */
let queue = Promise.resolve()

function enqueue(run) {
  const task = queue.then(run, run)
  queue = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}

const pending = new Map()

function synthesize(text, file) {
  return enqueue(async () => {
    await ensureEngine()
    const res = await fetch(`http://127.0.0.1:${TTS_PORT}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, out: file, speed: TTS_SPEED }),
      signal: AbortSignal.timeout(240_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`tts ${res.status}: ${data.error ?? 'unknown'}`)
    return data
  })
}

function cleanText(raw) {
  return String(raw ?? '')
    .replace(/```[\s\S]*?```/g, '。')
    .replace(/`[^`]*`/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_~#>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CHARS)
}

/* ------------------------------------------------------------------ *
 * 动态问候：每天 17:00 生成 5 段「今日台词」并合成语音。
 * 生成失败或缺文件时，读取 date 之前最近的可用文件；再没有就让前端回落内置语音。
 * ------------------------------------------------------------------ */
const GREET_DIR = join(HERE, 'greet-gen')
const GREET_SLOTS = ['morning', 'noon', 'afternoon', 'evening', 'night']
const GREET_GEN_HOUR = 17

function greetDayDir(stamp) {
  return join(GREET_DIR, stamp)
}

function todayStamp() {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function readGreetTexts(stamp) {
  try {
    const raw = readFileSync(join(greetDayDir(stamp), 'texts.json'), 'utf8')
    const data = JSON.parse(raw)
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

/* 返回该 slot 可用的语音文件：先今天，再往前找最近的 */
function resolveGreetFile(slot) {
  if (!GREET_SLOTS.includes(slot)) return null
  let stamps = []
  try {
    stamps = readdirSync(GREET_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse()
  } catch {
    return null
  }
  for (const stamp of stamps) {
    const file = join(greetDayDir(stamp), `${slot}.wav`)
    if (existsSync(file)) return { file, stamp }
  }
  return null
}

async function generateGreetingTexts() {
  const config = loadSummaryConfig()
  const apiKey = process.env.DEEPSEEK_API_KEY || config.apiKey || ''
  if (!apiKey) throw new Error('missing deepseek api key')
  const baseUrl = String(config.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '')
  const model = String(config.model || 'deepseek-chat')
  const yesterday = resolveGreetFile('morning')
  const prev = yesterday ? readGreetTexts(yesterday.stamp) : null
  const avoid = prev && prev.texts ? Object.values(prev.texts).join('；') : ''
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              '你在为一个桌面 AI 皮肤生成当天的问候语音台词。要求：严格输出 JSON，键为 morning/noon/afternoon/evening/night；每个值是一句中文短句，不超过 20 个字；语气是冷静、略带傲娇的女仆腔；五句之间不要重复；不要引号、不要表情、不要解释。',
          },
          {
            role: 'user',
            content: `今天是 ${todayStamp()}。昨天用过这些句子，别重复：${avoid || '（无）'}`,
          },
        ],
        max_tokens: 300,
        temperature: 0.9,
        stream: false,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`llm http ${response.status}`)
    const data = await response.json()
    const raw = String(data?.choices?.[0]?.message?.content || '').trim()
    const parsed = JSON.parse(raw)
    const texts = {}
    for (const slot of GREET_SLOTS) {
      const line = String(parsed?.[slot] || '').replace(/\s+/g, ' ').trim().slice(0, 20)
      if (line) texts[slot] = line
    }
    if (Object.keys(texts).length === 0) throw new Error('empty greeting texts')
    return texts
  } finally {
    clearTimeout(timer)
  }
}

async function generateGreetingsOnce() {
  const stamp = todayStamp()
  const dir = greetDayDir(stamp)
  if (existsSync(join(dir, 'texts.json'))) return 'already'
  const texts = await generateGreetingTexts()
  mkdirSync(dir, { recursive: true })
  const done = {}
  for (const [slot, line] of Object.entries(texts)) {
    const file = join(dir, `${slot}.wav`)
    try {
      await synthesize(line, file)
      done[slot] = line
    } catch (error) {
      // 单条失败不影响其它；缺的由前端回落到上一份
    }
  }
  if (Object.keys(done).length === 0) throw new Error('all slots failed')
  writeFileSync(join(dir, 'texts.json'), JSON.stringify({ date: stamp, texts: done }, null, 2), 'utf8')
  pruneGreetings()
  return Object.keys(done).join(',')
}

export function apply(ctx) {
  const webServer = ctx.webServer
  if (!webServer) return

  /* 会话运行态：宿主事件 → 内存里的 mood 状态机（thinking / working / done） */
  const mood = { running: false, since: 0, doneAt: 0 }
    const moodSeen = { api: 0, agent: 0, stream: 0, session: 0 }
  const markRunning = (running) => {
    if (running === mood.running) return
    mood.running = running
    if (running) {
      mood.since = Date.now()
    } else {
      mood.doneAt = Date.now()
    }
  }
  try {
    if (typeof ctx.on === 'function') {
      ctx.on('api-session/status', (_sessionId, running) => { moodSeen.api++; markRunning(Boolean(running)) })
      ctx.on('agent/status', (payload) => { moodSeen.agent++; markRunning(payload?.status === 'running') })
      // 插件中途重载时会错过 running=true 的边沿事件，用流式帧把状态补回来
      ctx.on('agent/assistant-stream', () => { moodSeen.stream++; markRunning(true) })
      ctx.on('session/event', () => { moodSeen.session++; markRunning(true) })
    }
  } catch {}


  ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: '/dsh-fairy-zzz-for-jediliu/summarize',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, reason: 'method not allowed' })
          return
        }
        let body = {}
        try {
          body = JSON.parse(await readBody(req, 32 * 1024))
        } catch {
          sendJson(res, 400, { ok: false, reason: 'bad request' })
          return
        }
        const text = String(body?.text || '').trim()
        if (!text) {
          sendJson(res, 400, { ok: false, reason: 'empty text' })
          return
        }
        if (!summarizeAllowed()) {
          sendJson(res, 429, { ok: false, reason: 'rate limited' })
          return
        }
        try {
          const summary = await summarizeText(text.slice(0, 4000))
          sendJson(res, 200, { ok: true, summary })
        } catch (cause) {
          sendJson(res, 502, { ok: false, reason: String(cause?.message || cause) })
        }
      },
    }),
  )

  /* 客户端决策追踪：把观察器每轮的判断写盘，便于不带控制台定位 DOM 情况 */
  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: '/dsh-fairy-zzz-for-jediliu/client-trace',
      handler: (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const e = String(url.searchParams.get('e') || '').slice(0, 400)
          if (e) appendFileSync(join(HERE, 'client-trace.log'), `${new Date().toISOString()}\t${e}\n`)
        } catch {}
        sendJson(res, 200, { ok: true })
      },
    }),
  )

  /* 客户端版本探针：前端装载时自报，落盘便于核对是否真的加载了新代码 */
  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: '/dsh-fairy-zzz-for-jediliu/client-ping',
      handler: (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rev = String(url.searchParams.get('rev') || '').slice(0, 64)
        try {
          const line = `${new Date().toISOString()}\t${rev}\t${req.headers['user-agent'] || ''}\n`
          writeFileSync(join(HERE, 'client-rev.log'), line, { flag: 'a' })
        } catch {}
        sendJson(res, 200, { ok: true, rev })
      },
    }),
  )

  /* 动态问候：按 slot 取当日（或最近一份）语音 */
  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: '/dsh-fairy-zzz-for-jediliu/greet',
      handler: (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rest = decodeURIComponent(
          url.pathname.slice('/dsh-fairy-zzz-for-jediliu/greet'.length),
        )
        const slot = rest.replace(/^\/+/, '').replace(/\.wav$/, '')
        const hit = resolveGreetFile(slot)
        if (!hit) {
          sendJson(res, 404, { ok: false, reason: 'no greeting' })
          return
        }
        return sendFile(req, res, hit.file)
      },
    }),
  )

  /* 每天 17:00 之后生成当日台词与语音；已有当日文件则跳过 */
  const runGreetCheck = (force) => {
    if (!force && new Date().getHours() < GREET_GEN_HOUR) return
    generateGreetingsOnce()
      .then((result) => {
        if (result !== 'already') {
          console.log(`[fairy] greeting generated: ${result}`)
        }
      })
      .catch((error) => {
        console.log(`[fairy] greeting skipped: ${String(error?.message || error)}`)
      })
  }
  const greetTimer = setInterval(() => runGreetCheck(false), 30 * 60 * 1000)
  if (typeof greetTimer.unref === 'function') greetTimer.unref()
  /* 首次装载：若从未生成过，先补一份，避免重启后一直是内置语音 */
  const bootGreet = setTimeout(() => {
    if (!existsSync(GREET_DIR) && new Date().getHours() >= GREET_GEN_HOUR) runGreetCheck(true)
    else runGreetCheck(false)
  }, 8000)
  if (typeof bootGreet.unref === 'function') bootGreet.unref()
  ctx.effect(() => () => {
    clearInterval(greetTimer)
    clearTimeout(bootGreet)
  })

  ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: '/dsh-fairy-zzz-for-jediliu/mood',
      handler: (req, res) => {
        const now = Date.now()
        let state = 'idle'
        if (mood.running) {
          state = now - mood.since > 2500 ? 'working' : 'thinking'
        } else if (mood.doneAt && now - mood.doneAt < 2400) {
          state = 'done'
        }
        sendJson(res, 200, {
          mood: state,
          running: mood.running,
          elapsed: mood.running ? now - mood.since : 0,
          doneAt: mood.doneAt,
        })
      },
    }),
  )

  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: '/dsh-fairy-zzz-for-jediliu/assets',
      handler: (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rest = decodeURIComponent(url.pathname.slice('/dsh-fairy-zzz-for-jediliu/assets'.length))
        const file = resolve(ASSETS, '.' + rest)
        if (!file.startsWith(ASSETS + sep)) {
          sendJson(res, 403, { error: 'forbidden' })
          return
        }
        return sendFile(req, res, file)
      },
    }),
  )

  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: '/dsh-fairy-zzz-for-jediliu/audio',
      handler: (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rest = decodeURIComponent(url.pathname.slice('/dsh-fairy-zzz-for-jediliu/audio'.length))
        if (!/^\/[a-f0-9]{40}\.wav$/.test(rest)) {
          sendJson(res, 404, { error: 'not found' })
          return
        }
        return sendFile(req, res, join(CACHE, rest.slice(1)))
      },
    }),
  )

  ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: '/dsh-fairy-zzz-for-jediliu/health',
      handler: async (req, res) => {
        syncVoiceHome()
        const engine = await engineState()
        sendJson(res, 200, {
          ok: true,
          engine: engine.up,
          engineState: engine.state,
          engineError: engine.error,
          engineHome: TTS_DIR,
          engineManaged: Boolean(engineChild),
          voiceHome: inspectVoiceDir(TTS_DIR),
          voice: 'Fairy · Ⅲ',
          speed: TTS_SPEED,
          on: typeof ctx.on,
          seen: moodSeen,
          mood: mood.running ? 'running' : 'idle',
        })
      },
    }),
  )

  ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: '/dsh-fairy-zzz-for-jediliu/voice-home',
      handler: async (req, res) => {
        syncVoiceHome()
        if (req.method !== 'POST') {
          sendJson(res, 200, { ok: true, ...inspectVoiceDir(TTS_DIR) })
          return
        }
        let body = {}
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          sendJson(res, 400, { ok: false, reason: 'bad request' })
          return
        }
        const raw = cleanHome(body?.home)
        if (body?.probe) {
          sendJson(res, 200, inspectVoiceDir(raw))
          return
        }
        if (!raw) {
          try {
            rmSync(VOICE_HINT, { force: true })
          } catch {}
          syncVoiceHome()
          sendJson(res, 200, { ok: true, ...inspectVoiceDir(TTS_DIR), cleared: true })
          return
        }
        const info = saveVoiceHome(raw)
        sendJson(res, info.ok ? 200 : 400, info)
      },
    }),
  )

  ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: '/dsh-fairy-zzz-for-jediliu/engine',
      handler: async (req, res) => {
        let action = 'status'
        if (req.method === 'POST') {
          try {
            const body = JSON.parse(await readBody(req, 4096))
            action = String(body?.action || 'status')
          } catch {
            sendJson(res, 400, { ok: false, error: 'bad request' })
            return
          }
        } else if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        syncVoiceHome()
        try {
          if (action === 'start') {
            await ensureEngine()
            sendJson(res, 200, { ok: true, engine: await engineState(), home: TTS_DIR })
            return
          }
          if (action === 'stop') {
            const stopped = await stopEngine()
            sendJson(res, 200, { ok: true, stopped, engine: await engineState(), home: TTS_DIR })
            return
          }
          sendJson(res, 200, { ok: true, engine: await engineState(), home: TTS_DIR, managed: Boolean(engineChild) })
        } catch (cause) {
          sendJson(res, 500, { ok: false, error: String(cause?.message ?? cause), home: TTS_DIR })
        }
      },
    }),
  )

  ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: '/dsh-fairy-zzz-for-jediliu/tts',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        let text = ''
        try {
          const body = JSON.parse(await readBody(req))
          text = cleanText(body?.text)
        } catch {
          sendJson(res, 400, { error: 'bad request' })
          return
        }
        if (!text) {
          sendJson(res, 400, { error: 'empty text' })
          return
        }
        const hash = createHash('sha1').update(text).digest('hex')
        const file = join(CACHE, `${hash}.wav`)
        const url = `/dsh-fairy-zzz-for-jediliu/audio/${hash}.wav`
        try {
          if ((await sizeOf(file)) > 0) {
            sendJson(res, 200, { ok: true, url, cached: true })
            return
          }
          let job = pending.get(hash)
          if (!job) {
            await mkdir(CACHE, { recursive: true })
            job = synthesize(text, file).finally(() => pending.delete(hash))
            pending.set(hash, job)
          }
          const data = await job
          if (sizeOf(file) > 0) pruneCache()
          sendJson(res, 200, { ok: true, url, cached: false, seconds: data?.seconds ?? 0 })
        } catch (cause) {
          sendJson(res, 502, { error: String(cause?.message ?? cause) })
        }
      },
    }),
  )
}
