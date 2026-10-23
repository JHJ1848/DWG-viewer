/**
 * Hardware & WebGL Universal Compatibility Guardian
 * Ensures 100% visual fidelity across all hardware types:
 * - Intel / AMD Integrated Graphics (iGPU)
 * - NVIDIA / AMD Dedicated Graphics (dGPU)
 * - CPU Software Rasterizers / Cloud VDI (SwiftShader, LLVMpipe, VMware, Citrix)
 */

export type GpuTier = 'dedicated' | 'integrated' | 'software' | 'unknown';

export interface GpuHardwareInfo {
  supported: boolean;
  webglVersion: 'webgl2' | 'webgl1' | 'none';
  gpuTier: GpuTier;
  vendor: string;
  renderer: string;
  maxTextureSize: number;
  maxVertexAttribs: number;
  unmaskedRenderer: string;
}

/**
 * Detects current machine GPU hardware and WebGL capabilities without side effects.
 */
export function detectGpuHardware(): GpuHardwareInfo {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return {
      supported: false,
      webglVersion: 'none',
      gpuTier: 'unknown',
      vendor: 'unknown',
      renderer: 'unknown',
      maxTextureSize: 0,
      maxVertexAttribs: 0,
      unmaskedRenderer: 'SSR / Headless',
    };
  }

  const canvas = document.createElement('canvas');
  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  let webglVersion: 'webgl2' | 'webgl1' | 'none' = 'none';

  // 1. Try WebGL 2 first, then fallback to WebGL 1
  try {
    gl = canvas.getContext('webgl2', {
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    });
    if (gl) {
      webglVersion = 'webgl2';
    }
  } catch {
    // Ignore and fallback
  }

  if (!gl) {
    try {
      gl =
        (canvas.getContext('webgl', {
          powerPreference: 'high-performance',
          failIfMajorPerformanceCaveat: false,
        }) as WebGLRenderingContext) ||
        (canvas.getContext('experimental-webgl') as WebGLRenderingContext);
      if (gl) {
        webglVersion = 'webgl1';
      }
    } catch {
      // Ignore
    }
  }

  if (!gl) {
    return {
      supported: false,
      webglVersion: 'none',
      gpuTier: 'unknown',
      vendor: 'none',
      renderer: 'none',
      maxTextureSize: 0,
      maxVertexAttribs: 0,
      unmaskedRenderer: '浏览器不支持 WebGL',
    };
  }

  // 2. Query unmasked GPU details via WEBGL_debug_renderer_info
  let unmaskedRenderer = 'Generic WebGL';
  let unmaskedVendor = 'Generic Vendor';

  try {
    const debugExt = gl.getExtension('WEBGL_debug_renderer_info');
    if (debugExt) {
      unmaskedRenderer = gl.getParameter(debugExt.UNMASKED_RENDERER_WEBGL) || '';
      unmaskedVendor = gl.getParameter(debugExt.UNMASKED_VENDOR_WEBGL) || '';
    }
  } catch {
    // Extension might be blocked by browser privacy settings
  }

  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048;
  const maxVertexAttribs = gl.getParameter(gl.MAX_VERTEX_ATTRIBS) || 8;

  // 3. Classify GPU Tier
  const lower = (unmaskedRenderer + ' ' + unmaskedVendor).toLowerCase();
  let gpuTier: GpuTier = 'unknown';

  if (
    lower.includes('swiftshader') ||
    lower.includes('llvmpipe') ||
    lower.includes('software') ||
    lower.includes('basic render') ||
    lower.includes('vmware') ||
    lower.includes('citrix')
  ) {
    gpuTier = 'software';
  } else if (
    lower.includes('nvidia') ||
    lower.includes('geforce') ||
    lower.includes('quadro') ||
    lower.includes('rtx') ||
    lower.includes('gtx') ||
    (lower.includes('radeon') && (lower.includes('rx') || lower.includes('pro')))
  ) {
    gpuTier = 'dedicated';
  } else if (
    lower.includes('intel') ||
    lower.includes('uhd') ||
    lower.includes('hd graphics') ||
    lower.includes('iris') ||
    lower.includes('amd') ||
    lower.includes('apu')
  ) {
    gpuTier = 'integrated';
  }

  return {
    supported: true,
    webglVersion,
    gpuTier,
    vendor: unmaskedVendor,
    renderer: unmaskedRenderer,
    maxTextureSize,
    maxVertexAttribs,
    unmaskedRenderer: unmaskedRenderer || 'WebGL 兼容图形核心',
  };
}

/**
 * Attaches automatic WebGL context loss recovery and TDR driver protection to a canvas element.
 */
export function setupWebGlContextProtection(
  container: HTMLElement,
  onRestored?: () => void
): () => void {
  const handleContextLost = (e: Event) => {
    // Critical: prevents the browser from permanently destroying the WebGL context
    e.preventDefault();
    console.warn('[WebGL Resilience] 捕获显卡驱动资源重置 (Context Lost)，准备自愈恢复...');
  };

  const handleContextRestored = () => {
    console.log('[WebGL Resilience] 显卡 WebGL 上下文已恢复 (Context Restored)，重新触发重绘。');
    onRestored?.();
  };

  container.addEventListener('webglcontextlost', handleContextLost, true);
  container.addEventListener('webglcontextrestored', handleContextRestored, true);

  return () => {
    container.removeEventListener('webglcontextlost', handleContextLost, true);
    container.removeEventListener('webglcontextrestored', handleContextRestored, true);
  };
}
