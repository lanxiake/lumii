/**
 * Stub for src/infra/ports.ts
 * Windows 客户端不需要端口诊断功能，提供简化实现
 */
import net from 'node:net'

export class PortInUseError extends Error {
  port: number
  constructor(port: number) {
    super(`Port ${port} is already in use.`)
    this.name = 'PortInUseError'
    this.port = port
  }
}

export async function ensurePortAvailable(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new PortInUseError(port))
      } else {
        reject(err)
      }
    })
    server.once('listening', () => {
      server.close(() => resolve())
    })
    server.listen(port, '127.0.0.1')
  })
}

export async function describePortOwner(_port: number): Promise<string | undefined> {
  return undefined
}
