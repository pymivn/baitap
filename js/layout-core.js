export const COMPACT_WIDTH_MAX = 768;
export const SHORT_LANDSCAPE_HEIGHT_MAX = 500;

const DEFAULT_VIEWPORT_WIDTH = 1024;
const DEFAULT_VIEWPORT_HEIGHT = 768;

function sanitizeDimension(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  return fallback;
}

function resolveToggle(current, forceOpen) {
  return typeof forceOpen === 'boolean' ? forceOpen : !current;
}

/**
 * Classify viewport dimensions into responsive layout modes.
 */
export function classifyViewport(rawViewport) {
  const width = sanitizeDimension(rawViewport?.width, DEFAULT_VIEWPORT_WIDTH);
  const height = sanitizeDimension(rawViewport?.height, DEFAULT_VIEWPORT_HEIGHT);
  const isCompactWidth = width <= COMPACT_WIDTH_MAX;
  // Soft keyboard on compact portrait phones can make height < width while width remains compact.
  const isShortLandscape =
    !isCompactWidth && height <= SHORT_LANDSCAPE_HEIGHT_MAX && width > height;
  const isSmallScreen = isCompactWidth || isShortLandscape;
  const explorerMode = isCompactWidth ? 'drawer' : 'sidebar';

  return {
    width,
    height,
    isCompactWidth,
    isShortLandscape,
    isSmallScreen,
    explorerMode,
  };
}

/**
 * Create the initial layout state for the current viewport.
 */
export function createInitialLayoutState(rawViewport) {
  const viewport = classifyViewport(rawViewport);
  return {
    viewport,
    explorerOpen: !viewport.isSmallScreen,
    terminalOpen: !viewport.isCompactWidth,
    guideOpen: false,
  };
}

/**
 * Toggle the file explorer panel. On compact widths, opening closes the guide drawer.
 */
export function toggleExplorer(state, forceOpen) {
  const explorerOpen = resolveToggle(state.explorerOpen, forceOpen);
  const guideOpen = state.viewport.isCompactWidth && explorerOpen ? false : state.guideOpen;
  return {
    ...state,
    explorerOpen,
    guideOpen,
  };
}

/**
 * Toggle the terminal panel. On compact widths, opening clears explorer and guide overlays.
 */
export function toggleTerminal(state, forceOpen) {
  const terminalOpen = resolveToggle(state.terminalOpen, forceOpen);
  const clearCompactOverlays = state.viewport.isCompactWidth && terminalOpen;
  return {
    ...state,
    terminalOpen,
    explorerOpen: clearCompactOverlays ? false : state.explorerOpen,
    guideOpen: clearCompactOverlays ? false : state.guideOpen,
  };
}

/**
 * Ensure the terminal is visible for code/PEP8 execution and unobscured on compact widths.
 */
export function openTerminalForExecution(state) {
  const clearCompactOverlays = state.viewport.isCompactWidth;
  return {
    ...state,
    terminalOpen: true,
    explorerOpen: clearCompactOverlays ? false : state.explorerOpen,
    guideOpen: clearCompactOverlays ? false : state.guideOpen,
  };
}

/**
 * Toggle the guide drawer. On compact widths, opening closes the explorer drawer.
 */
export function toggleGuide(state, forceOpen) {
  const guideOpen = resolveToggle(state.guideOpen, forceOpen);
  const explorerOpen = state.viewport.isCompactWidth && guideOpen ? false : state.explorerOpen;
  return {
    ...state,
    guideOpen,
    explorerOpen,
  };
}

/**
 * Auto-close the explorer when selecting a file in mobile drawer mode.
 */
export function onFileSelected(state) {
  if (state.viewport.explorerMode !== 'drawer') {
    return { ...state };
  }
  return {
    ...state,
    explorerOpen: false,
  };
}

/**
 * Recompute viewport classification on resize while preserving terminal visibility.
 */
export function onViewportResized(state, nextViewport) {
  const viewport = classifyViewport(nextViewport);
  const enteringSmallScreen = !state.viewport.isSmallScreen && viewport.isSmallScreen;
  const enteringCompactWidth = !state.viewport.isCompactWidth && viewport.isCompactWidth;
  return {
    ...state,
    viewport,
    explorerOpen: (enteringSmallScreen || enteringCompactWidth) ? false : state.explorerOpen,
  };
}

/**
 * Whether the modal backdrop behind compact overlay drawers should be shown.
 */
export function shouldShowBackdrop(state) {
  return Boolean(state.viewport.isCompactWidth && (state.explorerOpen || state.guideOpen));
}

/**
 * Whether focusing the terminal should happen automatically (disabled on mobile/small screens
 * so the on-screen keyboard does not pop up unexpectedly and cover editor or run output).
 */
export function shouldAutoFocusTerminal(state) {
  return Boolean(state.terminalOpen && !state.viewport.isSmallScreen);
}
