// Cross-process coordination for sharing a single Telegram bot token among
// multiple opencode sessions running in parallel.
//
// Why this exists: Telegram allows at most one concurrent getUpdates
// long-poll per bot token, and acknowledging an update via the offset
// parameter consumes it permanently. If every opencode plugin instance
// polled independently, they would race for updates and each session
// would see only a fraction of its own answers.
//
// Strategy: a leader-poller process owns the long-poll loop. Followers
// connect over a token-derived IPC endpoint (Unix domain socket on POSIX,
// named pipe on Windows) and receive raw Telegram updates from the leader
// as line-delimited JSON. Each follower hands updates to its own
// controller, which is the only entity that can recognize callback
// queries / reply-to messages addressed at *its* open questions; updates
// that don't match are ignored locally and forwarded along the chain.
//
// Leader election: try to `listen()` on the IPC path. On EADDRINUSE,
// connect as a follower. If the leader dies, the socket closes and every
// follower races to take over via the same listen-then-connect dance.

import { createHash } from "node:crypto"
import { createConnection, createServer, type Server, type Socket } from "node:net"
import { access, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

export type IPCMessage =
  // Leader -> follower: a raw Telegram update fetched by the leader.
  | { type: "update"; data: unknown }
  // Either direction: keepalive heartbeat (also detects half-open
  // connections). Followers reply to leader pings with pongs.
  | { type: "ping" }
  | { type: "pong" }

// Derive a stable per-bot-token path. Hash so the token never appears on
// disk in plain text. Truncate so the POSIX path stays under the 103/107
// byte sun_path limit on Linux/macOS.
export function ipcPathFor(token: string): string {
  const id = createHash("sha256").update(token).digest("hex").slice(0, 16)
  if (process.platform === "win32") return `\\\\?\\pipe\\opencode-telegram-${id}`
  return path.join(tmpdir(), `opencode-telegram-${id}.sock`)
}

export type LeaderRole = {
  role: "leader"
  // Broadcast a Telegram update to every follower. Safe to call from the
  // leader's polling loop.
  broadcast(message: IPCMessage): void
  // Number of currently connected followers (useful for logging /tests).
  followerCount(): number
  close(): Promise<void>
}

export type FollowerRole = {
  role: "follower"
  // Resolves on each incoming message from the leader. Returns an
  // unsubscribe.
  onMessage(handler: (msg: IPCMessage) => void): () => void
  // Fires once when the connection to the leader drops so the caller can
  // attempt re-election. The argument is the optional error.
  onDisconnect(handler: (err?: Error) => void): () => void
  close(): Promise<void>
}

export type IPCRole = LeaderRole | FollowerRole

export type IPCOptions = {
  path: string
  // Injected for tests so the real net module is never touched.
  netListen?: typeof defaultNetListen
  netConnect?: typeof defaultNetConnect
  unlinkStaleSocket?: (p: string) => Promise<void>
  // Heartbeat tuning. The leader pings every `heartbeatMs`; a peer that
  // misses `heartbeatTimeoutMs` worth of pongs is considered dead and is
  // dropped (leader) or triggers onDisconnect (follower). Defaults chosen
  // so a stalled long-poll or a half-open socket is detected within a few
  // seconds. Set heartbeatMs to 0 to disable (used by some tests).
  heartbeatMs?: number
  heartbeatTimeoutMs?: number
}

// Why heartbeats: a Unix-socket / named-pipe connection can go half-open
// (the peer process is gone or wedged but no FIN/RST arrives), so neither
// `close` nor `error` fires. Without a liveness probe a follower silently
// stops receiving Telegram updates while the leader keeps consuming them,
// so a tapped inline button is lost (it looks like Telegram "disconnected"
// even though the bot is still polling). The leader pings on an interval;
// followers pong. A peer that goes quiet past the timeout is torn down so
// the follower re-runs leader election and resumes receiving updates.
const DEFAULT_HEARTBEAT_MS = 5000
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15000

// Try to become the leader by listening on `path`. If the path is
// already taken, fall back to a follower connection. If a stale socket
// file exists (POSIX after a crash), remove it and retry once.
export async function joinOrLead(opts: IPCOptions): Promise<IPCRole> {
  const listen = opts.netListen ?? defaultNetListen
  const connect = opts.netConnect ?? defaultNetConnect
  const unlinkStale = opts.unlinkStaleSocket ?? defaultUnlinkStale

  // First, probe by connecting. If we can connect, a leader is already
  // alive; become a follower. If connect fails, attempt to listen.
  // On POSIX we pre-check the socket file's existence to avoid the cost
  // (and Bun-test cosmetic noise) of an inevitable ENOENT from connect.
  const hb = {
    heartbeatMs: opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    heartbeatTimeoutMs: opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
  }
  const probe = (await pathExists(opts.path)) ? await tryConnect(connect, opts.path) : undefined
  if (probe) return makeFollower(probe, hb)

  const first = await tryListen(listen, opts.path)
  if (first.ok) return makeLeader(first.server, hb)

  // listen failed. If it was EADDRINUSE, either a leader raced ahead of
  // us (try connect once more) or the socket file is stale (unlink and
  // retry listen, since connect already failed above).
  if (first.code === "EADDRINUSE") {
    const second = (await pathExists(opts.path)) ? await tryConnect(connect, opts.path) : undefined
    if (second) return makeFollower(second, hb)
    await unlinkStale(opts.path).catch(() => {})
    const third = await tryListen(listen, opts.path)
    if (third.ok) return makeLeader(third.server, hb)
  }
  throw new Error(`opencode-telegram-question: cannot bind nor connect IPC at ${opts.path}: ${first.code ?? "unknown"}`)
}

type Heartbeat = { heartbeatMs: number; heartbeatTimeoutMs: number }

function makeLeader(server: Server, hb: Heartbeat): LeaderRole {
  // Track the last time each peer proved itself alive (any inbound byte,
  // including a pong). Peers that go silent past the timeout are dropped
  // so a wedged or vanished follower can't pin a stale connection that
  // never receives the updates it's owed.
  const peers = new Map<Socket, { lastSeen: number }>()
  let pingTimer: ReturnType<typeof setInterval> | null = null

  function startHeartbeat(): void {
    if (hb.heartbeatMs <= 0 || pingTimer) return
    pingTimer = setInterval(() => {
      const now = Date.now()
      const line = JSON.stringify({ type: "ping" }) + "\n"
      for (const [peer, meta] of peers) {
        if (now - meta.lastSeen > hb.heartbeatTimeoutMs) {
          peers.delete(peer)
          peer.destroy()
          continue
        }
        if (peer.writable) peer.write(line)
      }
    }, hb.heartbeatMs)
    // Don't let the heartbeat keep the event loop alive on its own.
    pingTimer.unref?.()
  }

  server.on("connection", (socket) => {
    socket.setEncoding("utf8")
    peers.set(socket, { lastSeen: Date.now() })
    startHeartbeat()
    let buffer = ""
    socket.on("data", (chunk: string) => {
      // Any inbound traffic counts as a liveness signal. Followers reply to
      // pings with pongs; we also tolerate other future message types.
      const meta = peers.get(socket)
      if (meta) meta.lastSeen = Date.now()
      buffer += chunk
      let nl
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        // Leader currently doesn't act on follower message contents beyond
        // the liveness bump above; pongs simply refresh lastSeen. Future
        // extensions (e.g. outbound calls relayed through the leader) would
        // parse the line here.
      }
    })
    const dispose = () => {
      peers.delete(socket)
    }
    socket.on("close", dispose)
    socket.on("error", dispose)
  })
  return {
    role: "leader",
    broadcast(message) {
      const line = JSON.stringify(message) + "\n"
      for (const peer of peers.keys()) {
        if (!peer.writable) continue
        peer.write(line)
      }
    },
    followerCount: () => peers.size,
    close: () =>
      new Promise<void>((resolve) => {
        if (pingTimer) clearInterval(pingTimer)
        pingTimer = null
        for (const peer of peers.keys()) peer.destroy()
        server.close(() => resolve())
      }),
  }
}

function makeFollower(socket: Socket, hb: Heartbeat): FollowerRole {
  socket.setEncoding("utf8")
  const handlers = new Set<(msg: IPCMessage) => void>()
  const disconnectHandlers = new Set<(err?: Error) => void>()
  let buffer = ""
  let lastSeen = Date.now()
  let watchdog: ReturnType<typeof setInterval> | null = null
  let disconnected = false

  function fireDisconnect(err?: Error): void {
    if (disconnected) return
    disconnected = true
    if (watchdog) clearInterval(watchdog)
    watchdog = null
    for (const h of disconnectHandlers) h(err)
  }

  // Watchdog: if the leader stops pinging (it died or its socket went
  // half-open) we won't necessarily get a `close`/`error` event, so detect
  // silence ourselves and treat it as a disconnect so the caller re-elects.
  if (hb.heartbeatMs > 0) {
    watchdog = setInterval(() => {
      if (Date.now() - lastSeen > hb.heartbeatTimeoutMs) {
        socket.destroy()
        fireDisconnect(new Error("ipc heartbeat timeout"))
      }
    }, hb.heartbeatMs)
    watchdog.unref?.()
  }

  socket.on("data", (chunk: string) => {
    lastSeen = Date.now()
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      const parsed = safeParse(line)
      if (!parsed) continue
      // Reply to the leader's liveness pings so it knows we're alive.
      if (parsed.type === "ping") {
        if (socket.writable) socket.write(JSON.stringify({ type: "pong" }) + "\n")
        continue
      }
      if (parsed.type === "pong") continue
      for (const h of handlers) h(parsed)
    }
  })
  socket.on("close", () => fireDisconnect())
  socket.on("error", (err) => fireDisconnect(err))
  return {
    role: "follower",
    onMessage(h) {
      handlers.add(h)
      return () => handlers.delete(h)
    },
    onDisconnect(h) {
      disconnectHandlers.add(h)
      return () => disconnectHandlers.delete(h)
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (watchdog) clearInterval(watchdog)
        watchdog = null
        if (socket.destroyed) return resolve()
        socket.once("close", () => resolve())
        socket.destroy()
      }),
  }
}

function safeParse(line: string): IPCMessage | undefined {
  try {
    const obj = JSON.parse(line) as IPCMessage
    if (obj && typeof obj === "object" && typeof (obj as { type?: unknown }).type === "string") return obj
    return undefined
  } catch {
    return undefined
  }
}

type ListenResult = { ok: true; server: Server } | { ok: false; code?: string }

function tryListen(impl: typeof defaultNetListen, p: string): Promise<ListenResult> {
  return new Promise((resolve) => {
    const server = impl()
    server.once("error", (err: NodeJS.ErrnoException) => resolve({ ok: false, code: err.code }))
    server.listen(p, () => resolve({ ok: true, server }))
  })
}

function tryConnect(impl: typeof defaultNetConnect, p: string): Promise<Socket> {
  return new Promise((resolve) => {
    let settled = false
    let socket: Socket
    try {
      socket = impl(p)
    } catch {
      resolve(undefined as unknown as Socket)
      return
    }
    socket.on("error", () => {
      if (settled) return
      settled = true
      // Resolve with undefined instead of rejecting. Bun's test runner
      // treats any error event from `net.connect` failure as test output
      // even when the promise rejection is caught, so we channel failure
      // through a sentinel value and let the caller decide.
      try {
        socket.destroy()
      } catch {}
      resolve(undefined as unknown as Socket)
    })
    socket.once("connect", () => {
      if (settled) return
      settled = true
      resolve(socket)
    })
  })
}

function defaultNetListen(): Server {
  return createServer()
}

function defaultNetConnect(p: string): Socket {
  return createConnection(p)
}

async function pathExists(p: string): Promise<boolean> {
  // On Windows named pipes aren't real filesystem paths, so we can't
  // stat them; just try to connect.
  if (process.platform === "win32") return true
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function defaultUnlinkStale(p: string): Promise<void> {
  if (process.platform === "win32") return
  await unlink(p).catch(() => {})
}
