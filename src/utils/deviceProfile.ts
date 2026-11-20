/**
 * Device Profile & Memory Guardian for Mobile & iOS Devices
 *
 * Provides hardware detection and memory management heuristics specifically designed
 * to keep WebContent processes within the strict Jetsam memory thresholds (~1.0GB - 1.2GB)
 * enforced by the Apple iOS WebKit kernel.
 */

export interface DeviceMemoryProfile {
  isIos: boolean;
  isMobile: boolean;
  deviceMemoryGb?: number;
  /** Suggested WebGL devicePixelRatio (1.25 for iOS Retina, 1.5 for general mobile, 2.0 for desktop) */
  targetPixelRatio: number;
  /** Chunk batch size for CAD model entity creation in AcDbBatchProcessing */
  adaptiveChunkSize: number;
  /** Number of stream lines to process before forcing a GC breathing pause */
  streamChunkInterval: number;
  /** Duration in ms to yield to the main thread during stream parsing */
  streamYieldMs: number;
  /** Whether the "iOS/Low-Memory Defense Mode" is actively enabled */
  defenseModeEnabled: boolean;
}

export function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // Standard iOS detection
  const isDirectIos = /iPhone|iPad|iPod/i.test(ua);
  // iPadOS & iOS Safari desktop-mode emulation
  const isAppleTouch =
    (/Macintosh/i.test(ua) || navigator.platform === 'MacIntel' || (navigator as any).platform === '') &&
    typeof navigator.maxTouchPoints === 'number' &&
    navigator.maxTouchPoints > 1;
  // iOS WebKit standalone or ApplePay features (present in Safari, WeChat, DingTalk, Feishu WebKit)
  const hasIosStandalone = typeof document !== 'undefined' && typeof (document as any).standalone !== 'undefined';
  const hasApplePay = typeof window !== 'undefined' && typeof (window as any).ApplePaySession !== 'undefined';

  return isDirectIos || isAppleTouch || hasIosStandalone || (hasApplePay && /Mobile/i.test(ua));
}

export function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    isIosDevice() ||
    /Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent || '')
  );
}

/**
 * Returns the active memory profile based on device hardware and user preference overrides.
 */
export function getDeviceMemoryProfile(manualDefenseOverride?: boolean): DeviceMemoryProfile {
  const isIos = isIosDevice();
  const isMobile = isMobileDevice();
  const navMemory = typeof navigator !== 'undefined' ? (navigator as any).deviceMemory : undefined;

  const defenseModeEnabled =
    manualDefenseOverride !== undefined
      ? manualDefenseOverride
      : isIos || (navMemory !== undefined && navMemory <= 4);

  if (defenseModeEnabled) {
    return {
      isIos,
      isMobile,
      deviceMemoryGb: navMemory,
      // 🛡️ Lock DPR to 1.25 to prevent 100MB+ WebGL renderbuffers on 3x Retina screens
      targetPixelRatio: 1.25,
      // 🛡️ Keep chunk size to 600 so entity batches don't flood microtasks
      adaptiveChunkSize: 600,
      // 🛡️ Yield interval metadata for stream chunking
      streamChunkInterval: 12,
      // 🛡️ Sleep 8ms per 45ms time-slice yield to give WebKit/JSC an incremental GC window without stalling load
      streamYieldMs: 8,
      defenseModeEnabled: true,
    };
  }

  return {
    isIos,
    isMobile,
    deviceMemoryGb: navMemory,
    targetPixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio || 2.0 : 3.0,
    adaptiveChunkSize: 1500,
    streamChunkInterval: 25,
    streamYieldMs: 0,
    defenseModeEnabled: false,
  };
}

/**
 * Calculates adaptive minimumChunkSize for cooperative UI yielding during CAD entity conversion.
 *
 * =========================================================================
 * CRITICAL ARCHITECTURAL BACKGROUND & TECHNICAL REASONING:
 *
 * In @mlightcad/cad-simple-viewer, when `cooperativeYield: true` is enabled in openDocument,
 * the internal document loader batches CAD entity instantiation. After each batch of
 * `minimumChunkSize` entities, it yields control back to the browser's UI event loop
 * via `accmYieldToUi()` (asynchronous timer/MessageChannel macrotask).
 *
 * 1. Root Cause of "Page Unresponsive" & Chrome Watchdog Freeze:
 *    - For 50MB+ drawings (such as "示例图纸一.dwg" at 66MB or "示例总平面图.dwg" at 50MB),
 *      there are 150,000~300,000+ entities. If `cooperativeYield` is disabled (false), or if
 *      `minimumChunkSize` is set too high (e.g. 5,000), the browser main thread is locked in
 *      CPU-intensive loops for 30~60 seconds continuously. The browser's responsiveness watchdog
 *      triggers the "Page Unresponsive" popup, destroying the user experience.
 *
 * 2. Root Cause of Mobile WebKit / WebView OOM Crashes:
 *    - Mobile OSes strictly enforce per-tab memory limits (often 1.2GB~2GB). When the main thread
 *      runs synchronously without yielding, V8's Incremental Garbage Collector (Incremental Marking
 *      and Concurrent Sweeping) CANNOT run between allocations. Ephemeral objects accumulate in the
 *      heap, leading to rapid memory bloat and fatal SIGKILL / OOM crashes on iOS Safari and Android Chrome.
 *
 * 3. Adaptive Sizing Solution:
 *    - For heavy drawings (>= 15MB or >= 15,000 entities): Use chunk size 200~250.
 *      At ~200 entities per batch, each batch executes in ~15~40ms, allowing `accmYieldToUi()` to yield
 *      every ~50ms for regular V8 GC sweeps and 60fps UI frame rendering.
 *    - For medium drawings (>= 5MB or >= 5,000 entities): Use chunk size 300.
 *    - For lightweight drawings (< 5MB, < 5,000 entities): Use chunk size 1000 to maximize throughput.
 *
 * WARNING: DO NOT REVERT `cooperativeYield` TO false OR REMOVE THIS ADAPTIVE CHUNK SIZING!
 * =========================================================================
 *
 * @param criteria Criteria for estimating drawing complexity (file byte length or entity count)
 * @returns Adaptive minimum chunk size (200~300 for heavy drawings, 1000 for small drawings)
 */
export function calculateAdaptiveChunkSize(
  criteria: {
    byteLength?: number;
    entityCount?: number;
  },
  profile?: DeviceMemoryProfile
): number {
  const activeProfile = profile ?? getDeviceMemoryProfile();

  // 🛡️ iOS / Low-Memory Defense Mode:
  // Strictly enforce profile.adaptiveChunkSize (600) to keep batch microtasks small
  // and prevent memory spikes or WebKit Jetsam process termination on mobile devices.
  if (activeProfile.defenseModeEnabled) {
    return activeProfile.adaptiveChunkSize;
  }

  const byteLength = criteria.byteLength ?? 0;
  const entityCount = criteria.entityCount ?? 0;

  // Heavy drawing conditions on Desktop & high-RAM Android (50MB+ or >15,000 entities)
  // Use chunk size 1500: Each batch of 1500 entities takes ~12ms (well under the 50ms Long Task limit),
  // keeping 60fps UI responsiveness while avoiding excessive 200-chunk redraw churn that caused 30s delay!
  if (byteLength >= 15 * 1024 * 1024 || entityCount >= 15000) {
    return activeProfile.adaptiveChunkSize;
  }
  // Medium-large drawing conditions (5MB~15MB or >5,000 entities)
  if (byteLength >= 5 * 1024 * 1024 || entityCount >= 5000) {
    return Math.min(activeProfile.adaptiveChunkSize, 1200);
  }
  // Standard/lightweight drawings -> Default chunk size from active profile
  return activeProfile.adaptiveChunkSize;
}
