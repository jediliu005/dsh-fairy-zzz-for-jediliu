import { createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, appendFileSync, writeFileSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
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

/* —— 闲置自动停机 ——
   朗读结束后引擎会一直占着两三个 GB。闲置超过 IDLE_STOP_MS 就关掉，
   下一次朗读时 ensureEngine() 会重新拉起（冷启动约十到二十秒）。 */
const IDLE_STOP_MS = Number(process.env.FAIRY_TTS_IDLE_MS || 10 * 60 * 1000)
let lastVoiceTouch = Date.now()
let voiceBusy = 0

function touchVoice() {
  lastVoiceTouch = Date.now()
}

/* 引擎可能由 DSH 之外启动，没有 child 句柄，按端口找监听进程 */
function killByPort() {
  if (process.platform !== 'win32') return Promise.resolve(false)
  return new Promise((done) => {
    execFile('netstat', ['-ano'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return done(false)
      const line = String(stdout)
        .split(/\r?\n/)
        .find((row) => row.includes(`:${TTS_PORT}`) && /LISTENING/i.test(row))
      if (!line) return done(false)
      const parts = line.trim().split(/\s+/)
      const pid = Number(parts[parts.length - 1])
      if (!pid) return done(false)
      try {
        execFile('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }, () => done(true))
      } catch {
        done(false)
      }
    })
  })
}

async function stopEngineAnyWay() {
  const viaChild = await stopEngine()
  if (viaChild) return true
  return killByPort()
}

async function ensureEngine() {
  syncVoiceHome()
  /* 先探一次活：引擎可能被外部杀掉（任务管理器、崩溃、手动 taskkill），
     但 enginePromise 还留着上一次的成功结果，那样会直接返回 true
     然后拿着一个已经死掉的端口去请求，前端只会看到 502。 */
  const probe = await engineState()
  if (probe.up) {
    enginePromise = Promise.resolve(true)
    return true
  }
  enginePromise = null
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
    voiceBusy += 1
    try {
      await ensureEngine()
      touchVoice()
      const res = await fetch(`http://127.0.0.1:${TTS_PORT}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, out: file, speed: TTS_SPEED }),
        signal: AbortSignal.timeout(240_000),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(`tts ${res.status}: ${data.error ?? 'unknown'}`)
      return data
    } finally {
      voiceBusy -= 1
      touchVoice()
    }
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

/* 返回该 slot 的当日台词（与语音同源，供开机文字使用） */
function resolveGreetText(slot) {
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
    const data = readGreetTexts(stamp)
    const line = data && data.texts && typeof data.texts[slot] === 'string' ? data.texts[slot].trim() : ''
    if (line) return { text: line, stamp }
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
              [
                '你在为《绝区零》里的 AI「Fairy」生成当天的开机问候台词。',
                '身份：Ⅲ型总序式集成泛用人工智能；称呼用户为「主人」，自称「Fairy」。',
                '',
                '输出五个时段，每句 15 到 30 个汉字，一句话只做一件事，不要一句里塞两个特质：',
                '· morning：理性。带一个数字（能耗/故障率/概率），冷静陈述。',
                '· noon：理性。带一个数字（效率/进度/时间），冷静陈述。',
                '· afternoon：幽默。一本正经说残酷事实，或先肯定后致命转折。',
                '· evening：幽默。冷面毒舌地总结主人今天的表现。',
                '· night：傲娇。自夸、索要夸奖，或对别的智能设备吃醋。',
                '',
                '禁止：撒娇卖萌、女仆腔、讨好式夸奖、emoji、引号、英文、解释说明、以问句结尾。',
                '五句互不重复，也不要和给定旧句重复。',
                '只有 night 那句可以傲娇，其余四句不许撒娇。',
                '',
                '长度示范（照长度写，不要抄内容）：「晨检完成，系统故障率维持在万分之二，无需干预。」「傍晚了，Fairy 已替您关掉三个没用的进程。」',
                '只输出 JSON：{"morning":"...","noon":"...","afternoon":"...","evening":"...","night":"..."}',
              ].join('\n'),
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
      const line = fitGreetLine(parsed?.[slot])
      if (line) texts[slot] = line
    }
    if (Object.keys(texts).length === 0) throw new Error('empty greeting texts')
    return texts
  } finally {
    clearTimeout(timer)
  }
}

/* 台词长度控制：超长时在标点处收尾，宁可少一句也不留半句 */
function fitGreetLine(raw) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim()
  s = s.replace(/^[\s"'「『]+/, '').replace(/[\s"'」』]+$/, '')
  if (!s) return ''
  const LIMIT = 30
  const chars = [...s]
  if (chars.length <= LIMIT) return s
  const marks = '。！？；：，、'
  let cut = 0
  /* 优先在 12..29 字之间找到最后一个标点；找不到再退到 6..11 字；
     都没有就硬切——宁可句子短一点，也不要念出半截词。 */
  for (let i = LIMIT - 1; i >= 12; i -= 1) {
    if (marks.includes(chars[i])) {
      cut = i + 1
      break
    }
  }
  if (!cut) {
    for (let i = 11; i >= 6; i -= 1) {
      if (marks.includes(chars[i])) {
        cut = i + 1
        break
      }
    }
  }
  if (!cut) cut = LIMIT - 1
  let head = chars.slice(0, cut)
  /* 硬切时别把数字切碎（「92.7%」→「92.7」）：退到最后一个空格 */
  if (cut === LIMIT - 1) {
    for (let i = head.length - 1; i >= 12; i -= 1) {
      if (head[i] === ' ') {
        head = head.slice(0, i)
        break
      }
    }
  }
  let out = head.join('').replace(/[，、；：,;:]+$/, '')
  if (!/[。！？]$/.test(out)) out += '。'
  const final = [...out]
  if (final.length > LIMIT) {
    out = final.slice(0, LIMIT - 1).join('').replace(/[，、；：,;:。]+$/, '') + '。'
  }
  return out
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

  /* 当日台词文本：与 /greet 的语音同一份 texts.json，开机文字用它 */
  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: '/dsh-fairy-zzz-for-jediliu/greet-text',
      handler: (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rest = decodeURIComponent(
          url.pathname.slice('/dsh-fairy-zzz-for-jediliu/greet-text'.length),
        )
        const slot = rest.replace(/^\/+/, '')
        const hit = resolveGreetText(slot)
        if (!hit) {
          sendJson(res, 200, { ok: false, slot })
          return
        }
        sendJson(res, 200, { ok: true, slot, text: hit.text, date: hit.stamp })
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
  /* 闲置停机：每分钟检查一次，超过十分钟没合成就关掉引擎 */
  const idleTimer = setInterval(async () => {
    try {
      if (voiceBusy > 0) return
      if (Date.now() - lastVoiceTouch < IDLE_STOP_MS) return
      const st = await engineState()
      if (!st.up) return
      if (await stopEngineAnyWay()) {
        lastVoiceTouch = Date.now()
        console.log('[fairy-tts] engine stopped after idle', Math.round(IDLE_STOP_MS / 60000), 'min')
      }
    } catch {}
  }, 60 * 1000)
  if (typeof idleTimer.unref === 'function') idleTimer.unref()
  ctx.effect(() => () => clearInterval(idleTimer))

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
