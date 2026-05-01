/**
 * PeccyMini — cropped head + eyes, animated pupils.
 * Uses shared rendering from peccy-shared.
 * 4 char lines (8 pixel rows).
 */
import React, { useState, useEffect } from 'react';
import { Box } from 'ink';
import { O, W, K, _, type Pixel, type PupilPos, SEQUENCE, ANIM_INTERVAL, renderPixelGrid } from './peccy-shared.js';

function makeGrid(pos: PupilPos): Pixel[][] {
  const top: Pixel[][] = [
    [_, _, _, _, _, K, K, K, _, _, _, _, _],  // 0: loop
    [_, _, _, _, _, K, _, K, _, _, _, _, _],  // 1: loop hole
    [_, _, K, K, O, O, O, O, O, K, K, _, _],  // 2: head top
    [_, K, O, O, O, O, O, O, O, O, O, K, _],  // 3: head wide
  ];

  let eyeRow1: Pixel[];
  let eyeRow2: Pixel[];

  switch (pos) {
    case 'left':
      eyeRow1 = [_, K, O, W, W, W, O, W, W, W, O, K, _];
      eyeRow2 = [_, K, O, K, W, W, O, K, W, W, O, K, _];
      break;
    case 'right':
      eyeRow1 = [_, K, O, W, W, W, O, W, W, W, O, K, _];
      eyeRow2 = [_, K, O, W, W, K, O, W, W, K, O, K, _];
      break;
    case 'down':
      eyeRow1 = [_, K, O, W, W, W, O, W, W, W, O, K, _];
      eyeRow2 = [_, K, O, W, W, W, O, W, W, W, O, K, _]; // all white — pupils in row3
      break;
    case 'center':
    default:
      eyeRow1 = [_, K, O, W, W, W, O, W, W, W, O, K, _];
      eyeRow2 = [_, K, O, W, W, W, O, W, W, W, O, K, _]; // all white — pupils in row3
      break;
  }

  // Third eye row: pupils for center/down at bottom, or orange gap for left/right
  let eyeRow3: Pixel[];
  switch (pos) {
    case 'left':
    case 'right':
      // pupils already shown in eyeRow2, this is orange below
      eyeRow3 = [_, K, O, O, O, O, O, O, O, O, O, K, _];
      break;
    case 'down':
    case 'center':
    default:
      eyeRow3 = [_, K, O, W, K, W, O, W, K, W, O, K, _]; // pupils at bottom
      break;
  }

  // Orange row below — makes bottom pupils render as thin half-height dots
  const bottom: Pixel[] = [_, K, O, O, O, O, O, O, O, O, O, K, _];

  return [...top, eyeRow1, eyeRow2, eyeRow3, bottom];
}

const PeccyMini: React.FC = () => {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % SEQUENCE.length);
    }, ANIM_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  return (
    <Box flexDirection="column">
      {renderPixelGrid(makeGrid(SEQUENCE[frame]))}
    </Box>
  );
};

export default PeccyMini;
