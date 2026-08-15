import { execFile } from 'child_process'

let _gitAvailable: boolean | undefined

export async function isGitAvailable(): Promise<boolean> {
  if (_gitAvailable !== undefined) return _gitAvailable
  return new Promise((resolve) => {
    execFile('git', ['--version'], (err) => {
      _gitAvailable = !err
      resolve(_gitAvailable!)
    })
  })
}

export function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (err, stdout) => {
      if (err) { reject(err); return }
      resolve(stdout as string)
    })
  })
}
