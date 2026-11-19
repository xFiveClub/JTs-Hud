import net from 'net'

// Persistent connection to the CS2 console over netcon (launch CS2 with -netconport <port>).
//
// A single shared socket is used by both the Spectator Binds tool and the AI Director, so
// the two never fight over the port. Console output sent back by CS2 is read and discarded
// so the socket buffer never fills up.

const CONNECT_TIMEOUT_MS = 4000
const LINE_GAP_MS = 10

type Listener = (connected: boolean) => void

class NetconClient {
  private socket: net.Socket | null = null
  private host = '127.0.0.1'
  private port = 2020
  private connecting: Promise<void> | null = null
  private listeners = new Set<Listener>()
  // Serialise writes so multi-line batches from different callers never interleave
  private writeChain: Promise<void> = Promise.resolve()

  get connected(): boolean {
    return !!this.socket && !this.socket.destroyed && this.socket.readyState === 'open'
  }

  get target(): { host: string; port: number } {
    return { host: this.host, port: this.port }
  }

  onStatus(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(connected: boolean): void {
    for (const l of this.listeners) {
      try {
        l(connected)
      } catch {
        /* ignore listener errors */
      }
    }
  }

  /** Connect (or reuse the existing connection) to host:port. */
  connect(host: string, port: number): Promise<void> {
    port = Number(port)
    if (this.connected && this.host === host && this.port === port) return Promise.resolve()
    if (this.connecting && this.host === host && this.port === port) return this.connecting

    this.disconnect()
    this.host = host
    this.port = port

    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host, port })
      let settled = false

      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        if (this.socket === socket) this.socket = null
        reject(err)
      }

      const timer = setTimeout(() => fail(new Error('Telnet timeout')), CONNECT_TIMEOUT_MS)

      socket.setNoDelay(true)
      socket.setKeepAlive(true, 5000)
      // Drain CS2 console output; we don't parse it
      socket.on('data', () => {})

      socket.once('connect', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.socket = socket
        this.emit(true)
        resolve()
      })

      socket.on('error', (err) => fail(err))

      socket.on('close', () => {
        if (this.socket === socket) {
          this.socket = null
          this.emit(false)
        }
      })
    }).finally(() => {
      this.connecting = null
    })

    return this.connecting
  }

  disconnect(): void {
    if (this.socket) {
      const s = this.socket
      this.socket = null
      s.destroy()
      this.emit(false)
    }
  }

  /**
   * Send one or more console lines. Lines are written in order with a small gap between
   * them (CS2 can drop commands that arrive in the same packet burst).
   */
  send(lines: string | string[], host?: string, port?: number): Promise<void> {
    const list = (Array.isArray(lines) ? lines : String(lines).split('\n'))
      .map((l) => l.trim())
      .filter(Boolean)

    const run = async (): Promise<void> => {
      await this.connect(host ?? this.host, port ?? this.port)
      for (const line of list) {
        await new Promise<void>((resolve, reject) => {
          const s = this.socket
          if (!s) return reject(new Error('Telnet disconnected'))
          s.write(`${line}\r\n`, (err) => (err ? reject(err) : resolve()))
        })
        await new Promise((r) => setTimeout(r, LINE_GAP_MS))
      }
    }

    const p = this.writeChain.then(run, run)
    // Keep the chain alive even if this batch fails
    this.writeChain = p.catch(() => {})
    return p
  }
}

export const netcon = new NetconClient()
