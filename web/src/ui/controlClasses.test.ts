import { describe, expect, it } from 'vitest';
import { menubarButtonClass, toolTileClass } from './controlClasses';

describe('menubarButtonClass', () => {
  it('rests as a plain menubar control', () => {
    expect(menubarButtonClass(false)).toBe('menubar-btn');
  });

  it('flags an open control with the accent state class', () => {
    expect(menubarButtonClass(true)).toBe('menubar-btn active');
  });
});

describe('toolTileClass', () => {
  it('rests as a plain toolbox tile', () => {
    expect(toolTileClass(false)).toBe('tool');
  });

  it('flags the picked tile with the accent state class', () => {
    expect(toolTileClass(true)).toBe('tool active');
  });
});
