import React from 'react';
import { render } from 'ink';
import { TuiProvider } from './context.js';
import ErrorBoundary from './components/ErrorBoundary.js';
import App from './App.js';

// ── Alt screen buffer ───────────────────────────────────────────
// Like vim/htop — no scrollback, clean repaint.
const enterAltScreen = () => {
  process.stdout.write('\x1b[?1049h'); // enter alt buffer
  process.stdout.write('\x1b[?25l');   // hide cursor
};

const leaveAltScreen = () => {
  process.stdout.write('\x1b[?25h');   // show cursor
  process.stdout.write('\x1b[?1049l'); // leave alt buffer
};

enterAltScreen();

// Ensure terminal is restored on any exit path
const cleanup = () => { leaveAltScreen(); process.exit(0); };
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('uncaughtException', (err) => {
  leaveAltScreen();
  console.error(err);
  process.exit(1);
});

const { unmount, waitUntilExit } = render(
  <ErrorBoundary>
    <TuiProvider>
      <App />
    </TuiProvider>
  </ErrorBoundary>
);

waitUntilExit().then(() => {
  leaveAltScreen();
});
