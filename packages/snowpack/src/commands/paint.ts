import detectPort from 'detect-port';
import {EventEmitter} from 'events';
import * as colors from 'kleur/colors';
import path from 'path';
import readline from 'readline';
import util from 'util';
const cwd = process.cwd();

/**
 * Get the actual port, based on the `defaultPort`.
 * If the default port was not available, then we'll prompt the user if its okay
 * to use the next available port.
 */
export async function getPort(defaultPort: number): Promise<number> {
  const bestAvailablePort = await detectPort(defaultPort);
  if (defaultPort !== bestAvailablePort) {
    let useNextPort: boolean = false;
    if (process.stdout.isTTY) {
      const rl = readline.createInterface({input: process.stdin, output: process.stdout});
      useNextPort = await new Promise((resolve) => {
        rl.question(
          colors.yellow(
            `! Port ${colors.bold(defaultPort)} not available. Run on port ${colors.bold(
              bestAvailablePort,
            )} instead? (Y/n) `,
          ),
          (answer) => {
            resolve(!/^no?$/i.test(answer));
          },
        );
      });
      rl.close();
    }
    if (!useNextPort) {
      console.error(
        colors.red(
          `✘ Port ${colors.bold(defaultPort)} not available. Use ${colors.bold(
            '--port',
          )} to specify a different port.`,
        ),
      );
      console.error();
      process.exit(1);
    }
  }
  return bestAvailablePort;
}

interface WorkerState {
  done: boolean;
  state: null | [string, string];
  error: null | Error;
  output: string;
}
const WORKER_BASE_STATE: WorkerState = {done: false, error: null, state: null, output: ''};

export function paint(
  bus: EventEmitter,
  scripts: string[],
  devMode:
    | {
        addPackage: (pkgName: string) => void;
      }
    | undefined,
) {
  let port: number;
  let hostname: string;
  let protocol = '';
  let startTimeMs: number;
  let ips: string[] = [];
  let consoleOutput = '';
  let installOutput = '';
  let isInstalling = false;
  let missingWebModule: null | {id: string; spec: string; pkgName: string} = null;
  const allWorkerStates: Record<string, WorkerState> = {};
  const allFileBuilds = new Set<string>();

  for (const script of scripts) {
    allWorkerStates[script] = {...WORKER_BASE_STATE};
  }

  function setupWorker(id: string) {
    if (!allWorkerStates[id]) {
      allWorkerStates[id] = {...WORKER_BASE_STATE};
    }
  }

  function repaint() {
    // Clear Page
    process.stdout.write(process.platform === 'win32' ? '\x1B[2J\x1B[0f' : '\x1B[2J\x1B[3J\x1B[H');

    // Print the Console
    if (consoleOutput) {
      process.stdout.write(`${colors.underline(colors.bold('▼ Console'))}\n\n`);
      process.stdout.write(consoleOutput.trim().replace(/\n/gm, '\n  '));
      process.stdout.write('\n\n');
    }

    // Print the Workers
    for (const [script, workerState] of Object.entries(allWorkerStates)) {
      if (workerState.output) {
        const colorsFn = Array.isArray(workerState.error) ? colors.red : colors.reset;
        process.stdout.write(`${colorsFn(colors.underline(colors.bold('▼ ' + script)))}\n\n`);
        process.stdout.write(workerState.output.trim().replace(/\n/gm, '\n  '));
        process.stdout.write('\n\n');
      }
    }

    // Dashboard
    process.stdout.write(`${colors.bold('Snowpack')}\n\n`);
    const isServerStarted = startTimeMs > 0 && port > 0 && protocol;

    if (isServerStarted) {
      process.stdout.write(`  ${colors.bold(colors.cyan(`${protocol}//${hostname}:${port}`))}`);
      for (const ip of ips) {
        process.stdout.write(
          `${colors.cyan(` • `)}${colors.bold(colors.cyan(`${protocol}//${ip}:${port}`))}`,
        );
      }
      process.stdout.write('\n');
      process.stdout.write(
        colors.dim(
          startTimeMs < 1000 ? `  Server started in ${startTimeMs}ms.` : `  Server started.`, // Not to hide slow startup times, but likely there were extraneous factors (prompts, etc.) where the speed isn’t accurate
        ),
      );
      if (allFileBuilds.size > 0) {
        process.stdout.write(colors.dim(` Building...`));
      }
      process.stdout.write('\n\n');
    } else {
      process.stdout.write(colors.dim(`  Server starting…`) + '\n\n');
    }

    if (isInstalling) {
      process.stdout.write(`${colors.underline(colors.bold('▼ snowpack install'))}\n\n`);
      process.stdout.write('  ' + installOutput.trim().replace(/\n/gm, '\n  '));
      process.stdout.write('\n\n');
      return;
    }
  }

  /*
      import 'react';
      // snowpack fetches this from the CDN
      // saves it into a local cache - /Cache/snowpack/cdn/-/react-v16.13.1-hawhegawigawigahiw/react.js
      // Snowpack would serve it directly out of that cache
      // Snowpack would serve anything `/web_modules/*` out of `/Cache/snowpack/cdn/-/*`
    */

  /*

      TODO:
      - Cleaning this UI up a bit
        - What is the "empty state" / "start state" of this dev console?
        - First line? "Waiting for changes..."
        - can we make our default workers more concise?
        - "▼ run:tsc" (underlined, with down arrow) vs. "Snowpack" (not underlined, no down arrow)?
        - indenting within a section?
        - get the console logs to match the pino logger
      - cleaning up dev.ts a bit
        - getting rid of messageBus things we no longer care about
        - what is the message bus?
        - what is the run()->dev console interface? `{paint: (action: 'CLEAR' | 'PAINT', str: string)}`

        */

  bus.on('BUILD_FILE', ({id, isBuilding}) => {
    if (isBuilding) {
      allFileBuilds.add(path.relative(cwd, id));
    } else {
      allFileBuilds.delete(path.relative(cwd, id));
    }
    repaint();
  });
  bus.on('WORKER_START', ({id, state}) => {
    setupWorker(id);
    allWorkerStates[id].state = state || ['RUNNING', 'yellow'];
    repaint();
  });
  bus.on('WORKER_MSG', ({id, msg}) => {
    setupWorker(id);
    allWorkerStates[id].output += msg;
    repaint();
  });
  bus.on('WORKER_UPDATE', ({id, state}) => {
    if (typeof state !== undefined) {
      setupWorker(id);
      allWorkerStates[id].state = state;
    }
    repaint();
  });
  bus.on('WORKER_COMPLETE', ({id, error}) => {
    allWorkerStates[id].state = ['DONE', 'green'];
    allWorkerStates[id].done = true;
    allWorkerStates[id].error = allWorkerStates[id].error || error;
    repaint();
  });
  bus.on('WORKER_RESET', ({id}) => {
    allWorkerStates[id] = {...WORKER_BASE_STATE};
    repaint();
  });
  bus.on('CONSOLE', ({level, args}) => {
    if (isInstalling) {
      const msg = util.format.apply(util, args);
      if (!msg.startsWith('[404] ')) {
        installOutput += msg;
      }
    } else {
      consoleOutput += `[${level}] ${util.format.apply(util, args)}\n`;
    }
    repaint();
  });
  bus.on('INSTALLING', () => {
    isInstalling = true;
    installOutput = '';
    repaint();
  });
  bus.on('INSTALL_COMPLETE', () => {
    setTimeout(() => {
      missingWebModule = null;
      isInstalling = false;
      installOutput = '';
      consoleOutput = ``;
      repaint();
    }, 2000);
  });
  bus.on('MISSING_WEB_MODULE', ({id, data}) => {
    if (!missingWebModule && data) {
      missingWebModule = {id, ...data};
    }
    if (missingWebModule && missingWebModule.id === id) {
      if (!data) {
        missingWebModule = null;
      } else {
        missingWebModule = {id, ...data};
      }
    }
    repaint();
  });
  bus.on('SERVER_START', (info) => {
    startTimeMs = info.startTimeMs;
    hostname = info.hostname;
    port = info.port;
    protocol = info.protocol;
    ips = info.ips;
    repaint();
  });

  if (devMode) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.on('keypress', (_, key) => {
      if (key.name !== 'return' && key.name !== 'enter') {
        return;
      }
      if (!missingWebModule) {
        return;
      }
      devMode.addPackage(missingWebModule.pkgName);
      repaint();
    });
  }

  repaint();
}
