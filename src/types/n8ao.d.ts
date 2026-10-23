declare module 'n8ao' {
  import type { Camera, Scene } from 'three';
  import { Pass } from 'postprocessing';
  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    configuration: {
      aoRadius: number; distanceFalloff: number; intensity: number; aoSamples: number; denoiseSamples: number; denoiseRadius: number;
      halfRes: boolean; color: import('three').Color; gammaCorrection: boolean; screenSpaceRadius: boolean; transparencyAware: boolean;
    };
    setQualityMode(mode: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra'): void;
  }
}
