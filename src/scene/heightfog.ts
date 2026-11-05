/**
 * Height fog for every fogged material, by patching three's fog shader chunks once, before anything compiles. The
 * stock FogExp2 thickens with distance only; here it also thickens near the ground and thins with height, so the far
 * floor sinks into haze while pillar tops, spires and the sky line stay crisp: the cheapest way to give the arena depth.
 *
 * The world height comes from mvPosition and the view matrix (every shader that includes the fog chunks has both),
 * so sprites, points, skinned and instanced meshes, three.quarks particles and the stock materials all take it.
 * The realm keeps controlling colour and density through the scene's FogExp2; the height shape is shared.
 */
import * as THREE from 'three';

/** How fast the extra ground fog thins with height (per metre), and how much thicker the floor reads than the air. */
const FALLOFF = 0.32;
const GROUND = 1.7;
const AIR = 0.5;

let patched = false;

export function installHeightFog(): void {
  if (patched) return;
  patched = true;
  const C = THREE.ShaderChunk as unknown as Record<string, string>;
  C.fog_pars_vertex = `#ifdef USE_FOG
  varying float vFogDepth;
  varying float vFogHeight;
#endif`;
  C.fog_vertex = `#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  // world height of this vertex: the view matrix is rigid, so its inverse is the transposed rotation
  vFogHeight = (transpose(mat3(viewMatrix)) * (mvPosition.xyz - viewMatrix[3].xyz)).y;
#endif`;
  C.fog_pars_fragment = `#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying float vFogHeight;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;
  C.fog_fragment = `#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  // height: thick on the floor, thin in the air
  fogFactor *= mix( ${AIR.toFixed(2)}, ${GROUND.toFixed(2)}, exp( - max( vFogHeight, 0.0 ) * ${FALLOFF.toFixed(2)} ) );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, clamp( fogFactor, 0.0, 1.0 ) );
#endif`;
}
