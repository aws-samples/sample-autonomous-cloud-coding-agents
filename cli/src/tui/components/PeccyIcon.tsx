/**
 * Peccy full-size pixel-art icon — animated pupils.
 * Uses shared rendering from peccy-shared.
 */
import React, { useState, useEffect } from 'react';
import { Box } from 'ink';
import { O, W, K, _, type Pixel, type PupilPos, SEQUENCE, ANIM_INTERVAL, renderPixelGrid } from './peccy-shared.js';

// Full Peccy has 3 eye rows → 'down' looks visually different from 'center'
function makeGrid(pos: PupilPos): Pixel[][] {
  const top: Pixel[][] = [
    [_, _, _, _, _, K, K, K, _, _, _, _, _],  // 0: loop
    [_, _, _, _, _, K, _, K, _, _, _, _, _],  // 1: loop hole
    [_, _, K, K, O, O, O, O, O, K, K, _, _],  // 2: head top
    [_, K, O, O, O, O, O, O, O, O, O, K, _],  // 3: head
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
      // 'down' = pupils at bottom — white top, white mid, pupil bottom
      eyeRow1 = [_, K, O, W, W, W, O, W, W, W, O, K, _];  // all white
      eyeRow2 = [_, K, O, W, W, W, O, W, W, W, O, K, _];  // all white
      break;
    case 'center':
    default:
      eyeRow1 = [_, K, O, W, W, W, O, W, W, W, O, K, _];
      eyeRow2 = [_, K, O, W, K, W, O, W, K, W, O, K, _];
      break;
  }

  // Third eye row: only 'down' has pupils here, others are just orange below
  const eyeRow3: Pixel[] = pos === 'down'
    ? [_, K, O, W, K, W, O, W, K, W, O, K, _]  // pupils at very bottom
    : [_, K, O, O, O, O, O, O, O, O, O, K, _];  // orange (below eyes)

  const bottom: Pixel[][] = [
    [_, K, O, O, K, O, O, O, K, O, O, K, _],  // 7: smile (symmetric U)
    [K, K, O, O, O, K, K, K, O, O, O, K, K],  // 8: curve + arms
    [K, O, O, O, O, O, O, O, O, O, O, O, K],  // 9: arms wide
    [_, K, O, O, O, O, O, O, O, O, O, K, _],  // 10: body
    [_, K, O, O, O, K, K, K, O, O, O, K, _],  // 11: legs
    [_, _, K, K, K, _, _, _, K, K, K, _, _],  // 12: feet
    [_, _, _, _, _, _, _, _, _, _, _, _, _],  // 13: pad
  ];

  return [...top, eyeRow1, eyeRow2, eyeRow3, ...bottom];
}

const PeccyIcon: React.FC = () => {
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

export default PeccyIcon;
