// One reading thread (see pool.js): reads its batch of files with the reader it was given and posts back the
// tally, plus running totals now and then for the loading screen. Read-only; nothing leaves this computer.

import { parentPort, workerData } from 'node:worker_threads';
import { snapshot } from './pool.js';

const { reader, files, win } = workerData;
const mod = await import(reader);
const t = await mod.readList(files, win, (i, tally) => parentPort.postMessage({ type: 'tick', i, snap: snapshot(tally) }));
parentPort.postMessage({ type: 'done', t });
