import assert from 'node:assert/strict';
import test from 'node:test';

import { checkVisibilityRay } from '../src/raycast.js';

function grid(values, nx = 4, ny = 4) {
  return { data: Float32Array.from(values), nx, ny, cellM: 10, maxDist: 15 };
}

test('clear rays are visible and a raised cell blocks an intersecting ray', () => {
  const clearTerrain = grid(new Array(16).fill(-100));
  assert.equal(checkVisibilityRay(0, 30, 2, clearTerrain, null), true);

  const blockedTerrain = grid(new Array(16).fill(100));
  assert.equal(checkVisibilityRay(0, 0, 2, blockedTerrain, null), false);
});

test('azimuth is clockwise from north and grids are centered on the lander', () => {
  const values = new Array(16).fill(-100);
  values[1 * 4 + 3] = 100;
  const terrain = grid(values);

  assert.equal(checkVisibilityRay(90, 0, 2, terrain, null), false);
  assert.equal(checkVisibilityRay(270, 0, 2, terrain, null), true);
});

test('invalid grids and missing terrain are rejected', () => {
  assert.throws(() => checkVisibilityRay(0, 0, 2, null, null), /grid is required/);
  assert.throws(
    () => checkVisibilityRay(0, 0, 2, { data: [], nx: 2, ny: 2, cellM: 10 }, null),
    /valid dimensions/,
  );
});
