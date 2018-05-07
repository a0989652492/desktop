import { exec, spawn } from 'child_process'
import * as os from 'os'
import * as Path from 'path'
import * as fs from 'fs'

import { TypedBaseStore } from './base-store'
import { mkdirIfNeeded } from '../file-system'

import { TroubleshootingState, TroubleshootingStep } from '../../models/ssh'
import { Repository } from '../../models/repository'
import { getSSHEnvironment } from '../ssh'

export class TroubleshootingStore extends TypedBaseStore<TroubleshootingState | null> {
  private state: TroubleshootingState | null = null

  public constructor() {
    super()

    this.reset()
  }

  /**
   * Update the internal state of the store and emit an update
   * event.
   */
  private setState(state: TroubleshootingState | null) {
    this.state = state
    this.emitUpdate(this.getState())
  }

  /**
   * Returns the current state of the sign in store or null if
   * no sign in process is in flight.
   */
  public getState(): TroubleshootingState | null {
    return this.state
  }

  public reset() {
    this.setState({ kind: TroubleshootingStep.InitialState, isLoading: false })
  }

  public async validateHost(host: string) {
    const homeDir = os.homedir()
    const sshDir = Path.join(homeDir, '.ssh')
    await mkdirIfNeeded(sshDir)

    const command = 'ssh-keyscan'
    const env = await getSSHEnvironment(command)

    return new Promise<void>((resolve, reject) => {
      const keyscan = spawn(`ssh-keyscan`, [host], { env })
      const knownHostsPath = Path.join(homeDir, '.ssh', 'known_hosts')

      keyscan.stdout.pipe(fs.createWriteStream(knownHostsPath))
      keyscan.on('close', code => {
        if (code !== 0) {
          reject(
            new Error(
              `ssh-keyscan exited with code '${code}' while adding '${host}' which was not expected`
            )
          )
          return
        }
        resolve()
      })
    })
  }

  public async start(repository: Repository) {
    this.setState({ kind: TroubleshootingStep.InitialState, isLoading: true })
    const command = 'ssh'
    const env = await getSSHEnvironment(command)

    // TODO: how to resolve the host for GHE environments?
    const host = 'git@github.com'

    exec(
      `${command} -Tv  -o 'StrictHostKeyChecking=yes' ${host}`,
      { timeout: 15000, env },
      (error, stdout, stderr) => {
        if (error != null) {
          // TODO: poke at these details, pass them through
        }

        const noValidHostKeyFoundRe = /No RSA host key is known for (.*) and you have requested strict checking/
        const hostMatch = noValidHostKeyFoundRe.exec(stderr)

        if (hostMatch != null) {
          const host = hostMatch[1]

          const fingerprintRe = /Server host key: (.*) (.*)/
          const match = fingerprintRe.exec(stderr)

          if (match == null) {
            log.warn(
              `Could not find fingerprint details where they were expected`
            )
            // TODO: redirect to generic error
            return
          }

          const fingerprint = match[2]
          const rawOutput = `The authenticity of host '${host}' can't be established.\nRSA key fingerprint is ${fingerprint}.`

          this.setState({
            kind: TroubleshootingStep.ValidateHost,
            rawOutput,
            host,
          })
        } else {
          this.setState({
            kind: TroubleshootingStep.Unknown,
            output: stdout,
            error: stderr,
          })
        }
      }
    )
  }
}