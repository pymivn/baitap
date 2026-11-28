import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPACT_WIDTH_MAX,
  SHORT_LANDSCAPE_HEIGHT_MAX,
  classifyViewport,
  createInitialLayoutState,
  toggleExplorer,
  toggleTerminal,
  openTerminalForExecution,
  toggleGuide,
  onFileSelected,
  onViewportResized,
  shouldShowBackdrop,
  shouldAutoFocusTerminal,
} from '../../js/layout-core.js';

describe('layout-core: constants and classifyViewport', () => {
  it('exports expected breakpoint constants', () => {
    assert.equal(COMPACT_WIDTH_MAX, 768);
    assert.equal(SHORT_LANDSCAPE_HEIGHT_MAX, 500);
  });

  it('classifies desktop viewport (1440x900)', () => {
    const vp = classifyViewport({ width: 1440, height: 900 });
    assert.equal(vp.isCompactWidth, false);
    assert.equal(vp.isShortLandscape, false);
    assert.equal(vp.isSmallScreen, false);
    assert.equal(vp.explorerMode, 'sidebar');
  });

  it('classifies Pixel 6 portrait (412x915)', () => {
    const vp = classifyViewport({ width: 412, height: 915 });
    assert.equal(vp.isCompactWidth, true);
    assert.equal(vp.isShortLandscape, false);
    assert.equal(vp.isSmallScreen, true);
    assert.equal(vp.explorerMode, 'drawer');
  });

  it('classifies Pixel 6 landscape (915x412)', () => {
    const vp = classifyViewport({ width: 915, height: 412 });
    assert.equal(vp.isCompactWidth, false);
    assert.equal(vp.isShortLandscape, true);
    assert.equal(vp.isSmallScreen, true);
    assert.equal(vp.explorerMode, 'sidebar');
  });

  it('handles invalid or missing dimensions safely without throwing', () => {
    for (const bad of [undefined, null, {}, { width: NaN, height: -50 }, { width: 'wide', height: 0 }]) {
      const vp = classifyViewport(bad);
      assert.equal(typeof vp.isCompactWidth, 'boolean');
      assert.equal(typeof vp.isShortLandscape, 'boolean');
      assert.equal(typeof vp.isSmallScreen, 'boolean');
      assert.ok(vp.explorerMode === 'sidebar' || vp.explorerMode === 'drawer');
    }
  });
});

describe('layout-core: createInitialLayoutState', () => {
  it('opens explorer and terminal on desktop', () => {
    const state = createInitialLayoutState({ width: 1440, height: 900 });
    assert.equal(state.explorerOpen, true);
    assert.equal(state.terminalOpen, true);
    assert.equal(state.guideOpen, false);
  });

  it('collapses explorer and terminal on Pixel 6 portrait (412x915)', () => {
    const state = createInitialLayoutState({ width: 412, height: 915 });
    assert.equal(state.explorerOpen, false);
    assert.equal(state.terminalOpen, false);
    assert.equal(state.guideOpen, false);
  });

  it('collapses explorer but keeps terminal open on Pixel 6 landscape (915x412)', () => {
    const state = createInitialLayoutState({ width: 915, height: 412 });
    assert.equal(state.explorerOpen, false);
    assert.equal(state.terminalOpen, true);
    assert.equal(state.guideOpen, false);
  });
});

describe('layout-core: toggles and panel coordination', () => {
  it('toggleExplorer toggles and closes guide on compact width when opening', () => {
    const initial = createInitialLayoutState({ width: 412, height: 915 });
    const withGuide = toggleGuide(initial, true);
    assert.equal(withGuide.guideOpen, true);

    const withExplorer = toggleExplorer(withGuide);
    assert.equal(withExplorer.explorerOpen, true);
    assert.equal(withExplorer.guideOpen, false);

    const closed = toggleExplorer(withExplorer, false);
    assert.equal(closed.explorerOpen, false);
  });

  it('toggleExplorer keeps guide open on desktop', () => {
    const initial = createInitialLayoutState({ width: 1440, height: 900 });
    const withGuide = toggleGuide(initial, true);
    const closedExplorer = toggleExplorer(withGuide, false);
    const reopenedExplorer = toggleExplorer(closedExplorer, true);
    assert.equal(reopenedExplorer.explorerOpen, true);
    assert.equal(reopenedExplorer.guideOpen, true);
  });

  it('toggleTerminal toggles and closes explorer and guide on compact width when opening', () => {
    const initial = createInitialLayoutState({ width: 412, height: 915 });
    const withExplorer = toggleExplorer(initial, true);
    const withTerminal = toggleTerminal(withExplorer);
    assert.equal(withTerminal.terminalOpen, true);
    assert.equal(withTerminal.explorerOpen, false);
    assert.equal(withTerminal.guideOpen, false);

    const withGuide = toggleGuide(withTerminal, true);
    const reopenedTerminal = toggleTerminal(toggleTerminal(withGuide, false), true);
    assert.equal(reopenedTerminal.terminalOpen, true);
    assert.equal(reopenedTerminal.explorerOpen, false);
    assert.equal(reopenedTerminal.guideOpen, false);
  });

  it('openTerminalForExecution always opens terminal and clears compact overlays', () => {
    const portrait = createInitialLayoutState({ width: 412, height: 915 });
    const withExplorer = toggleExplorer(portrait, true);
    const afterExec = openTerminalForExecution(withExplorer);
    assert.equal(afterExec.terminalOpen, true);
    assert.equal(afterExec.explorerOpen, false);
    assert.equal(afterExec.guideOpen, false);

    const withGuide = toggleGuide(afterExec, true);
    const afterExec2 = openTerminalForExecution(withGuide);
    assert.equal(afterExec2.terminalOpen, true);
    assert.equal(afterExec2.explorerOpen, false);
    assert.equal(afterExec2.guideOpen, false);
  });

  it('toggleGuide toggles and closes explorer on compact width when opening', () => {
    const portrait = createInitialLayoutState({ width: 412, height: 915 });
    const withExplorer = toggleExplorer(portrait, true);
    const withGuide = toggleGuide(withExplorer);
    assert.equal(withGuide.guideOpen, true);
    assert.equal(withGuide.explorerOpen, false);

    const closed = toggleGuide(withGuide, false);
    assert.equal(closed.guideOpen, false);
  });

  it('onFileSelected closes explorer in drawer mode and keeps it in sidebar mode', () => {
    const portraitOpen = toggleExplorer(createInitialLayoutState({ width: 412, height: 915 }), true);
    const afterSelectPortrait = onFileSelected(portraitOpen);
    assert.equal(afterSelectPortrait.explorerOpen, false);

    const desktopOpen = createInitialLayoutState({ width: 1440, height: 900 });
    const afterSelectDesktop = onFileSelected(desktopOpen);
    assert.equal(afterSelectDesktop.explorerOpen, true);
  });
});

describe('layout-core: onViewportResized and predicates', () => {
  it('auto-collapses explorer when resizing desktop -> Pixel 6 portrait while preserving terminalOpen', () => {
    const desktop = createInitialLayoutState({ width: 1440, height: 900 });
    assert.equal(desktop.explorerOpen, true);
    assert.equal(desktop.terminalOpen, true);

    const resized = onViewportResized(desktop, { width: 412, height: 915 });
    assert.equal(resized.explorerOpen, false);
    assert.equal(resized.terminalOpen, true);
    assert.equal(resized.viewport.explorerMode, 'drawer');
  });

  it('does NOT close terminal when soft keyboard opens on Pixel 6 portrait (412x800 -> 412x380)', () => {
    const portrait = createInitialLayoutState({ width: 412, height: 800 });
    const withTerm = toggleTerminal(portrait, true);
    assert.equal(withTerm.terminalOpen, true);

    const withKeyboard = onViewportResized(withTerm, { width: 412, height: 380 });
    assert.equal(withKeyboard.terminalOpen, true);
    assert.equal(withKeyboard.viewport.isCompactWidth, true);
  });

  it('updates explorerMode to sidebar when rotating Pixel 6 portrait -> landscape', () => {
    const portrait = createInitialLayoutState({ width: 412, height: 915 });
    assert.equal(portrait.viewport.explorerMode, 'drawer');

    const landscape = onViewportResized(portrait, { width: 915, height: 412 });
    assert.equal(landscape.viewport.explorerMode, 'sidebar');
    assert.equal(landscape.viewport.isShortLandscape, true);
  });

  it('closes explorer when rotating Pixel 6 landscape -> portrait with explorer and guide open', () => {
    const landscape = createInitialLayoutState({ width: 915, height: 412 });
    const withBothOpen = toggleGuide(toggleExplorer(landscape, true), true);
    assert.equal(withBothOpen.explorerOpen, true);
    assert.equal(withBothOpen.guideOpen, true);

    const portrait = onViewportResized(withBothOpen, { width: 412, height: 915 });
    assert.equal(portrait.explorerOpen, false);
    assert.equal(portrait.guideOpen, true);
    assert.equal(portrait.viewport.explorerMode, 'drawer');
  });

  it('computes shouldShowBackdrop and shouldAutoFocusTerminal accurately', () => {
    const desktop = createInitialLayoutState({ width: 1440, height: 900 });
    assert.equal(shouldShowBackdrop(desktop), false);
    assert.equal(shouldAutoFocusTerminal(desktop), true);

    const desktopClosedTerm = toggleTerminal(desktop, false);
    assert.equal(shouldAutoFocusTerminal(desktopClosedTerm), false);

    const portrait = createInitialLayoutState({ width: 412, height: 915 });
    assert.equal(shouldShowBackdrop(portrait), false);
    assert.equal(shouldAutoFocusTerminal(portrait), false);

    const portraitExplorer = toggleExplorer(portrait, true);
    assert.equal(shouldShowBackdrop(portraitExplorer), true);

    const portraitGuide = toggleGuide(portrait, true);
    assert.equal(shouldShowBackdrop(portraitGuide), true);

    const portraitTerm = toggleTerminal(portrait, true);
    assert.equal(shouldShowBackdrop(portraitTerm), false);
    assert.equal(shouldAutoFocusTerminal(portraitTerm), false);

    const landscape = createInitialLayoutState({ width: 915, height: 412 });
    assert.equal(shouldAutoFocusTerminal(landscape), false);
    assert.equal(shouldShowBackdrop(toggleExplorer(landscape, true)), false);
  });
});
