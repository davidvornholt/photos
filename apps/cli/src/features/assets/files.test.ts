import { describe, expect, it } from 'bun:test';
import { asset, id } from '../../app/command-fixtures.ts';
import type { Asset } from './assets.ts';
import { originalNames, safeFileName } from './files.ts';

describe('safeFileName', () => {
  it.each([
    ['IMG_0001.HEIC', 'IMG_0001.HEIC'],
    ['../secret', '.._secret'],
    ['a\\b/c', 'a_b_c'],
    ['line\nbreak.jpg', 'line_break.jpg'],
    ['..', 'fallback'],
    ['   ', 'fallback'],
  ])('turns %j into %j', (name, expected) => {
    expect(safeFileName(name, 'fallback')).toBe(expected);
  });
});

describe('originalNames', () => {
  it('tells apart photos with the same name by their ids', () => {
    const assets = [
      asset(id(1), { originalFileName: 'scan.jpg' }),
      asset(id(2), { originalFileName: 'scan.jpg' }),
      asset(id(3), { originalFileName: 'other.jpg' }),
      asset(id(4), { originalFileName: 'README' }),
      asset(id(5), { originalFileName: 'README' }),
    ] as unknown as ReadonlyArray<Asset>;
    expect(originalNames(assets)).toEqual([
      'scan-00000001.jpg',
      'scan-00000002.jpg',
      'other.jpg',
      'README-00000004',
      'README-00000005',
    ]);
  });
});
