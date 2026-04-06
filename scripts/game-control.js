// ============================================================================
// Game Control — interactive terminal controller for gladAItors
// ============================================================================
// Usage:
//   node scripts/game-control.js                  (interactive — pick a game)
//   node scripts/game-control.js territory-war    (load territory war)
//   node scripts/game-control.js trading-pit      (load trading pit)
//
// Keyboard shortcuts:
//   g  — Go (start the loaded game)
//   s  — Stop & reset
//   p  — Pause / resume
//   r  — Reload (stop, reset, reload same game — shows starting positions)
//   ?  — Show status
//   q  — Quit
// ============================================================================

const http = require('http');
const readline = require('readline');

const API_BASE = process.env.API_URL || 'http://localhost:8000';

const GAMES = {
  'territory-war': { name: 'Territory War' },
  'trading-pit': { name: 'Trading Pit' },
};

// --- HTTP helper ---

function apiCall(method, path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve({ raw: body });
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.end();
  });
}

// --- Actions ---

async function loadGame(gameKey, rounds = null) {
  const game = GAMES[gameKey];
  if (!game) {
    console.log(`  Unknown game: ${gameKey}`);
    console.log(`  Available: ${Object.keys(GAMES).join(', ')}`);
    return false;
  }

  try {
    const roundsParam = rounds ? `?rounds=${rounds}` : '';
    const result = await apiCall('POST', `/games/load/${gameKey}${roundsParam}`);
    if (result.status === 'error') {
      console.log(`  Error: ${result.message}`);
      return false;
    }
    console.log(`\n  ${game.name} loaded — ${result.ticks} rounds, tier ${result.tier || '?'}`);
    const modelList = (result.models || []).map(m =>
      typeof m === 'string' ? m : `${m.name} (${m.model_id})`
    );
    console.log(`  Models: ${modelList.join(', ')}`);
    console.log(`  Press [g] to start\n`);
    return true;
  } catch (err) {
    console.log(`  Error: ${err.message}`);
    console.log('  Is the backend running? (npm run dev:backend)\n');
    return false;
  }
}

async function goGame() {
  try {
    const result = await apiCall('POST', '/games/start');
    if (result.status === 'error') {
      console.log(`  ${result.message}`);
    } else {
      console.log(`  Game started — ${result.game}`);
    }
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }
}

async function rotatePositions() {
  try {
    const result = await apiCall('POST', '/games/rotate');
    if (result.status === 'error') {
      console.log(`  ${result.message}`);
    } else {
      console.log('  Positions rotated:');
      for (const [model, corner] of Object.entries(result.positions)) {
        console.log(`    ${model} → ${corner}`);
      }
    }
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }
}

async function setTier(tier) {
  try {
    const result = await apiCall('POST', `/models/tier/${tier}`);
    if (result.status === 'error') {
      console.log(`  ${result.message}`);
    } else {
      console.log(`  Tier ${result.tier} set:`);
      for (const m of result.models) {
        console.log(`    ${m.name}: ${m.model_id}`);
      }
      console.log('  Takes effect on next game load (r)');
    }
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }
}

async function stopGame() {
  try {
    const result = await apiCall('POST', '/games/stop');
    console.log(`  Game ${result.status}`);
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }
}

async function pauseGame() {
  try {
    const result = await apiCall('POST', '/games/pause');
    console.log(`  Game ${result.status}`);
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }
}

async function showStatus() {
  try {
    const result = await apiCall('GET', '/games/status');
    if (result.status === 'idle') {
      console.log('  No game loaded');
    } else if (result.status === 'loaded') {
      console.log(`  Game: ${result.game} | Status: loaded (waiting for [g]) | Ticks: ${result.max_ticks}`);
    } else {
      console.log(`  Game: ${result.game} | Status: ${result.status} | Tick: ${result.tick}/${result.max_ticks}`);
    }
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }
}

// --- Interactive mode ---

function showHelp() {
  console.log('');
  console.log('  Keyboard shortcuts:');
  console.log('    g  — Go (start the loaded game)');
  console.log('    c  — Cycle starting positions (before start)');
  console.log('    1  — Set tier 1 (cheap: Haiku, GPT-4o-mini, Gemini 2.0 Flash)');
  console.log('    2  — Set tier 2 (recording: Sonnet, GPT-4o, Gemini 2.5 Flash)');
  console.log('    3  — Set tier 3 (premium: Opus, GPT-4o, Gemini 2.5 Pro)');
  console.log('    n  — Set number of rounds (then reload with r)');
  console.log('    s  — Stop & reset');
  console.log('    p  — Pause / resume');
  console.log('    r  — Reload (stop, reset, reload same game)');
  console.log('    ?  — Show status');
  console.log('    q  — Quit');
  console.log('');
}

async function interactive(gameKey) {
  console.log('');
  console.log('  ⚔️  gladAItors — Game Control');
  console.log('  ─────────────────────────────');

  // If no game specified, prompt for one
  if (!gameKey) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
      console.log('');
      Object.entries(GAMES).forEach(([key, game], i) => {
        console.log(`    ${i + 1}. ${game.name} (${key})`);
      });
      console.log('');
      rl.question('  Pick a game (1/2 or name): ', resolve);
    });
    rl.close();

    const keys = Object.keys(GAMES);
    const num = parseInt(answer, 10);
    if (num >= 1 && num <= keys.length) {
      gameKey = keys[num - 1];
    } else if (GAMES[answer]) {
      gameKey = answer;
    } else {
      console.log('  Invalid selection');
      process.exit(1);
    }
  }

  const loaded = await loadGame(gameKey, roundsArg);
  if (!loaded) process.exit(1);

  showHelp();

  // Raw mode for single keypress detection
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  let inputLocked = false;

  process.stdin.on('data', async (key) => {
    if (inputLocked) return;
    switch (key.toLowerCase()) {
      case 'g':
        await goGame();
        break;
      case 'c':
        await rotatePositions();
        break;
      case '1':
        await setTier(1);
        break;
      case '2':
        await setTier(2);
        break;
      case '3':
        await setTier(3);
        break;
      case 'n': {
        // Collect round count inline — lock input while typing
        inputLocked = true;
        let digits = '';
        process.stdout.write('  Rounds: ');
        const onDigit = (k) => {
          if (k === '\r' || k === '\n') {
            process.stdin.removeListener('data', onDigit);
            inputLocked = false;
            console.log('');
            const num = parseInt(digits, 10);
            if (isNaN(num) || num < 1) {
              console.log('  Invalid number');
            } else {
              roundsArg = num;
              console.log(`  Rounds set to ${num} — press [r] to reload`);
            }
          } else if (k === '\u007f' || k === '\b') {
            if (digits.length > 0) {
              digits = digits.slice(0, -1);
              process.stdout.write('\b \b');
            }
          } else if (k >= '0' && k <= '9') {
            digits += k;
            process.stdout.write(k);
          } else if (k === '\u0003') {
            process.stdin.removeListener('data', onDigit);
            inputLocked = false;
            console.log('\n  Cancelled');
          }
        };
        process.stdin.on('data', onDigit);
        break;
      }
      case 's':
        await stopGame();
        break;
      case 'p':
        await pauseGame();
        break;
      case 'r':
        console.log('  Loading...');
        // Check if there's an active game to stop first
        try {
          const status = await apiCall('GET', '/games/status');
          if (status.status !== 'idle') {
            await stopGame();
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        } catch { /* no game running */ }
        await loadGame(gameKey, roundsArg);
        break;
      case '?':
        await showStatus();
        break;
      case 'q':
      case '\u0003': // Ctrl+C
        console.log('  Stopping and exiting...');
        await stopGame().catch(() => {});
        process.exit(0);
        break;
      default:
        break;
    }
  });

  process.on('SIGINT', async () => {
    console.log('\n  Stopping...');
    await stopGame().catch(() => {});
    process.exit(0);
  });
}

// --- Entry point ---
// Parse args: game-control.js [game-name] [rounds]
// Examples:
//   game-control.js territory-war        → 100 rounds (default)
//   game-control.js territory-war 50     → 50 rounds
const args = process.argv.slice(2);
let gameArg = null;
let roundsArg = null;

for (const arg of args) {
  const num = parseInt(arg, 10);
  if (!isNaN(num)) {
    roundsArg = num;
  } else {
    gameArg = arg;
  }
}

interactive(gameArg);
