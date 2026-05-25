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
}

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
  const probe = (await pathExists(opts.path)) ? await tryConnect(connect, opts.path) : undefined
  if (probe) return makeFollower(probe)

  const first = await tryListen(listen, opts.path)
  if (first.ok) return makeLeader(first.server)

  // listen failed. If it was EADDRINUSE, either a leader raced ahead of
  // us (try connect once more) or the socket file is stale (unlink and
  // retry listen, since connect already failed above).
  if (first.code === "EADDRINUSE") {
    const second = (await pathExists(opts.path)) ? await tryConnect(connect, opts.path) : undefined
    if (second) return makeFollower(second)
    await unlinkStale(opts.path).catch(() => {})
    const third = await tryListen(listen, opts.path)
    if (third.ok) return makeLeader(third.server)
  }
  throw new Error(`opencode-telegram-question: cannot bind nor connect IPC at ${opts.path}: ${first.code ?? "unknown"}`)
}

function makeLeader(server: Server): LeaderRole {
  const peers = new Set<Socket>()
  server.on("connection", (socket) => {
    socket.setEncoding("utf8")
    peers.add(socket)
    let buffer = ""
    socket.on("data", (chunk: string) => {
      buffer += chunk
      let nl
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        // Leader currently doesn't act on follower messages besides
        // dropping them; pings are answered by the leader's send loop
        // every interval. Future extensions (e.g. outbound calls relayed
        // through leader) would parse here.
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
      for (const peer of peers) {
        if (!peer.writable) continue
        peer.write(line)
      }
    },
    followerCount: () => peers.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const peer of peers) peer.destroy()
        server.close(() => resolve())
      }),
  }
}

function makeFollower(socket: Socket): FollowerRole {
  socket.setEncoding("utf8")
  const handlers = new Set<(msg: IPCMessage) => void>()
  const disconnectHandlers = new Set<(err?: Error) => void>()
  let buffer = ""
  socket.on("data", (chunk: string) => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      const parsed = safeParse(line)
      if (!parsed) continue
      for (const h of handlers) h(parsed)
    }
  })
  socket.on("close", () => {
    for (const h of disconnectHandlers) h()
  })
  socket.on("error", (err) => {
    for (const h of disconnectHandlers) h(err)
  })
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
