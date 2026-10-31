/**
 * Tests for Canvas Renderer
 *
 * Note: Most renderer tests are visual and require a browser environment.
 * These tests verify theme configuration and drawing invalidation with the real
 * WASM parser and a mocked Canvas2D context.
 * Full visual tests are in examples/renderer-demo.html
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Ghostty, type GhosttyTerminal } from './ghostty';
import { CanvasRenderer, DEFAULT_THEME } from './renderer';
import { SelectionManager } from './selection-manager';
import type { Terminal } from './terminal';

describe('CanvasRenderer', () => {
  describe('Default Theme', () => {
    test('has all required ANSI colors', () => {
      expect(DEFAULT_THEME.black).toBe('#000000');
      expect(DEFAULT_THEME.red).toBe('#cd3131');
      expect(DEFAULT_THEME.green).toBe('#0dbc79');
      expect(DEFAULT_THEME.yellow).toBe('#e5e510');
      expect(DEFAULT_THEME.blue).toBe('#2472c8');
      expect(DEFAULT_THEME.magenta).toBe('#bc3fbc');
      expect(DEFAULT_THEME.cyan).toBe('#11a8cd');
      expect(DEFAULT_THEME.white).toBe('#e5e5e5');
    });

    test('has all bright ANSI colors', () => {
      expect(DEFAULT_THEME.brightBlack).toBe('#666666');
      expect(DEFAULT_THEME.brightRed).toBe('#f14c4c');
      expect(DEFAULT_THEME.brightGreen).toBe('#23d18b');
      expect(DEFAULT_THEME.brightYellow).toBe('#f5f543');
      expect(DEFAULT_THEME.brightBlue).toBe('#3b8eea');
      expect(DEFAULT_THEME.brightMagenta).toBe('#d670d6');
      expect(DEFAULT_THEME.brightCyan).toBe('#29b8db');
      expect(DEFAULT_THEME.brightWhite).toBe('#ffffff');
    });

    test('has foreground and background colors', () => {
      expect(DEFAULT_THEME.foreground).toBe('#d4d4d4');
      expect(DEFAULT_THEME.background).toBe('#1e1e1e');
    });

    test('has cursor colors', () => {
      expect(DEFAULT_THEME.cursor).toBe('#ffffff');
      expect(DEFAULT_THEME.cursorAccent).toBe('#1e1e1e');
    });

    test('has selection colors', () => {
      // Selection colors are now solid (not semi-transparent overlay)
      // Ghostty-style: selection bg = foreground color, selection fg = background color
      expect(DEFAULT_THEME.selectionBackground).toBe('#d4d4d4');
      expect(DEFAULT_THEME.selectionForeground).toBe('#1e1e1e');
    });
  });

  describe('Theme Color Format', () => {
    test('all colors are valid hex strings', () => {
      const hexPattern = /^#[0-9a-f]{6}$/i;

      expect(DEFAULT_THEME.black).toMatch(hexPattern);
      expect(DEFAULT_THEME.foreground).toMatch(hexPattern);
      expect(DEFAULT_THEME.background).toMatch(hexPattern);
      expect(DEFAULT_THEME.cursor).toMatch(hexPattern);
    });
  });

  describe('Drawing invalidation', () => {
    // Exercise the actual renderer and WASM parser. Only the canvas and blink
    // timer are mocked; ticking the captured timer avoids wall-clock flakes.
    const context = {
      measureText: () => ({ width: 8, actualBoundingBoxAscent: 11, actualBoundingBoxDescent: 3 }),
      scale: mock(() => {}),
      clearRect: mock(() => {}),
      fillRect: mock(() => {}),
      fillText: mock(() => {}),
      beginPath: mock(() => {}),
      moveTo: mock(() => {}),
      lineTo: mock(() => {}),
      stroke: mock(() => {}),
      save: mock(() => {}),
      restore: mock(() => {}),
      rect: mock(() => {}),
      clip: mock(() => {}),
    };
    let buffer: GhosttyTerminal;
    let renderer: CanvasRenderer;
    let selection: SelectionManager | undefined;
    let viewport: number;
    let opacity: number;
    let tickBlink: () => void;
    let blinkInterval: number | undefined;

    const paint = (force = false) => renderer.render(buffer, force, viewport, buffer, opacity);
    const resetDraws = () => {
      context.fillText.mockClear();
      context.fillRect.mockClear();
      context.clearRect.mockClear();
      context.stroke.mockClear();
    };
    const expectNoDrawing = () => {
      expect(context.fillText.mock.calls.length).toBe(0);
      expect(context.fillRect.mock.calls.length).toBe(0);
      expect(context.clearRect.mock.calls.length).toBe(0);
      expect(context.stroke.mock.calls.length).toBe(0);
    };
    const expectPaintThenIdle = () => {
      paint();
      expect(context.fillText).toHaveBeenCalled();
      resetDraws();
      paint();
      expectNoDrawing();
    };

    beforeEach(async () => {
      spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
        context as unknown as CanvasRenderingContext2D
      );
      spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
        if (typeof callback !== 'function') throw new Error('Expected a blink callback');
        tickBlink = () => callback();
        blinkInterval = delay;
        return -1;
      });
      const ghostty = await Ghostty.load(new URL('../ghostty-vt.wasm', import.meta.url).pathname);
      buffer = ghostty.createTerminal(80, 24, { scrollbackLimit: 100 });
      buffer.write(
        Array.from({ length: 150 }, (_, i) => 'Line ' + i + ': static history\r\n').join('')
      );
      renderer = new CanvasRenderer(document.createElement('canvas'), { cursorBlink: true });
      selection = undefined;
      viewport = 0;
      opacity = 0;
      resetDraws();
    });

    afterEach(() => {
      selection?.dispose();
      renderer.dispose();
      buffer.free();
      mock.restore();
    });

    test('does not draw static scrollback across 300 frames, including hidden cursor blinks', () => {
      viewport = 20;
      paint();
      resetDraws();
      const clearDirty = spyOn(buffer, 'clearDirty');
      for (let frame = 0; frame < 300; frame++) {
        if (frame % 32 === 0) tickBlink();
        paint();
      }
      expectNoDrawing();
      expect(clearDirty).not.toHaveBeenCalled();
    });

    test('paints the visible cursor only at its original blink transitions', () => {
      expect(blinkInterval).toBe(530);
      paint();
      resetDraws();
      for (let frame = 0; frame < 30; frame++) paint();
      expectNoDrawing();
      tickBlink();
      expectPaintThenIdle();
      tickBlink();
      expectPaintThenIdle();
    });

    test('preserves intermediate smooth-scroll frames and then becomes idle', () => {
      paint();
      for (const position of [0.25, 0.75, 1, 2.5, 20, 0]) {
        viewport = position;
        resetDraws();
        expectPaintThenIdle();
      }
    });

    test('paints new output even with unchanged cursor coordinates and scrollback length', () => {
      viewport = 20;
      paint();
      const cursor = buffer.getCursor();
      const length = buffer.getScrollbackLength();
      resetDraws();
      buffer.write('\x1b7\x1b[HReplacement output\x1b8');
      expect(buffer.getCursor()).toEqual(cursor);
      expect(buffer.getScrollbackLength()).toBe(length);
      expectPaintThenIdle();
      buffer.write('More new output\r\n'.repeat(50));
      expect(buffer.getScrollbackLength()).toBeGreaterThan(length);
      expectPaintThenIdle();
    });

    test('paints changed cells when a TUI restores the cursor after updating', () => {
      buffer.write('\x1b[?1049h\x1b[2J\x1b[Hstatus: old\x1b[H');
      paint();
      const cursor = buffer.getCursor();
      resetDraws();
      buffer.write('\x1b[Hstatus: new\x1b[H');
      expect(buffer.getCursor()).toEqual(cursor);
      expectPaintThenIdle();
      expect(
        buffer
          .getLine(0)
          ?.slice(0, 11)
          .map((cell) => String.fromCodePoint(cell.codepoint))
          .join('')
      ).toBe('status: new');
    });

    test('preserves alternate-screen entry and restoration', () => {
      paint();
      for (const sequence of ['\x1b[?1049h\x1b[2J\x1b[HTUI', '\x1b[?1049l']) {
        resetDraws();
        buffer.write(sequence);
        expectPaintThenIdle();
      }
      expect(buffer.isAlternateScreen()).toBe(false);
    });

    test('restores the cursor row on movement, hiding and style changes without blinking', () => {
      renderer.setCursorBlink(false);
      paint();
      for (const sequence of ['\x1b[3;5H', '\x1b[?25l', '\x1b[?25h']) {
        resetDraws();
        buffer.write(sequence);
        paint();
        expect(context.clearRect).toHaveBeenCalled();
        expect(context.fillText).toHaveBeenCalled();
        resetDraws();
        paint();
        expectNoDrawing();
      }
      renderer.setCursorStyle('bar');
      paint();
      expect(context.clearRect).toHaveBeenCalled();
      expect(context.fillText).toHaveBeenCalled();
      resetDraws();
      paint();
      expectNoDrawing();
    });

    test('preserves selection changes and clearing without continuously painting a selection', () => {
      viewport = 20;
      const terminal = { cols: 80, rows: 24, viewportY: viewport } as Terminal;
      selection = new SelectionManager(
        terminal,
        renderer,
        buffer,
        document.createElement('textarea')
      );
      renderer.setSelectionManager(selection);
      paint();
      selection.selectLines(2, 3);
      expect(selection.getSelectionCoords()).toMatchObject({ startRow: 2, endRow: 3 });
      paint();
      resetDraws();
      paint();
      expectNoDrawing();
      selection.selectLines(2, 4);
      paint();
      expect(context.fillText).toHaveBeenCalled();
      resetDraws();
      selection.clearSelection();
      paint();
      expect(context.fillText).toHaveBeenCalled();
      resetDraws();
      paint();
      expectNoDrawing();
    });

    test('preserves link hover changes and scrollbar fades', () => {
      viewport = 20;
      paint();
      const range = { startX: 0, startY: 1, endX: 8, endY: 1 };
      for (const endX of [8, 12]) {
        resetDraws();
        range.endX = endX;
        renderer.setHoveredLinkRange(range);
        expectPaintThenIdle();
      }
      resetDraws();
      renderer.setHoveredLinkRange(null);
      expectPaintThenIdle();
      resetDraws();
      renderer.setHoveredHyperlinkId(1);
      expectPaintThenIdle();
      for (const value of [1, 0.5, 0.1, 0]) {
        opacity = value;
        resetDraws();
        expectPaintThenIdle();
      }
    });

    test('restores the text under the scrollbar when its fade reaches zero', () => {
      opacity = 0.1;
      paint();
      resetDraws();
      opacity = 0;
      paint();
      expect(context.fillText.mock.calls.length).toBeGreaterThanOrEqual(80 * 24);
      resetDraws();
      paint();
      expectNoDrawing();
    });

    test('fully paints a replacement buffer even when its dirty flags are clean', async () => {
      paint();
      const ghostty = await Ghostty.load(new URL('../ghostty-vt.wasm', import.meta.url).pathname);
      const replacement = ghostty.createTerminal(80, 24);
      replacement.write('Replacement buffer');
      replacement.getCursor();
      replacement.clearDirty();
      buffer.free();
      buffer = replacement;
      resetDraws();
      paint();
      expect(context.fillText.mock.calls.length).toBeGreaterThanOrEqual(80 * 24);
      resetDraws();
      paint();
      expectNoDrawing();
    });

    test.each(['resize', 'font', 'font size', 'remeasure', 'theme', 'clear', 'force'])(
      'invalidates an otherwise identical frame after %s',
      (change) => {
        paint();
        if (change === 'resize') renderer.resize(80, 24);
        if (change === 'font') renderer.setFontFamily('another-monospace');
        if (change === 'font size') renderer.setFontSize(17);
        if (change === 'remeasure') renderer.remeasureFont();
        if (change === 'theme') renderer.setTheme({ background: '#123456' });
        if (change === 'clear') renderer.clear();
        resetDraws();
        paint(change === 'force');
        expect(context.fillText.mock.calls.length).toBeGreaterThanOrEqual(80 * 24);
        resetDraws();
        paint();
        expectNoDrawing();
      }
    );
  });
});
