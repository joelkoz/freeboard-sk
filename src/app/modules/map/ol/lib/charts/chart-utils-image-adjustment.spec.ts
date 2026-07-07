import { describe, it, expect } from 'vitest';
import { imageAdjustmentToFilter } from './chart-utils';

describe('imageAdjustmentToFilter (#457)', () => {
  it('returns an empty string when no adjustment is supplied', () => {
    expect(imageAdjustmentToFilter(undefined)).toBe('');
  });

  it('returns an empty string for a neutral adjustment (no filter applied)', () => {
    expect(imageAdjustmentToFilter({ brightness: 1, contrast: 1 })).toBe('');
  });

  it('builds a CSS filter string for a non-neutral adjustment', () => {
    expect(imageAdjustmentToFilter({ brightness: 1.3, contrast: 0.7 })).toBe(
      'brightness(1.3) contrast(0.7)'
    );
  });

  it('treats a single changed channel as non-neutral', () => {
    expect(imageAdjustmentToFilter({ brightness: 1.2, contrast: 1 })).toBe(
      'brightness(1.2) contrast(1)'
    );
  });
});
