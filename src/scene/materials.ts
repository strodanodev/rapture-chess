/** Stage materials: ivory marble and obsidian squares, forged frame, Rapture gold, and the avatars' re-finish. */
import * as THREE from 'three';
import { marbleTexture } from './assets';

export function boardMaterials(): Record<string, THREE.Material> {
  const marble = marbleTexture();
  return {
    board_light: new THREE.MeshPhysicalMaterial({ map: marble, color: 0xe8e1d2, roughness: 0.5, metalness: 0, clearcoat: 0, envMapIntensity: 0.55 }),
    board_dark: new THREE.MeshPhysicalMaterial({ color: 0x0a0a0f, roughness: 0.22, metalness: 0.15, clearcoat: 0.8, clearcoatRoughness: 0.18, envMapIntensity: 1.0 }),
    board_frame: new THREE.MeshStandardMaterial({ color: 0x121014, roughness: 0.42, metalness: 0.9, envMapIntensity: 1.0 }),
    rapture_gold: new THREE.MeshStandardMaterial({ color: 0xffbf5e, roughness: 0.26, metalness: 1, envMapIntensity: 1.4 }),
    plinth_stone: new THREE.MeshStandardMaterial({ color: 0x15151c, roughness: 0.38, metalness: 0.75, envMapIntensity: 1.0 }),
    plinth_rune: new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 1, metalness: 0, emissive: 0xffc070, emissiveIntensity: 2.2 }),
  };
}

const luma = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/**
 * The avatars are authored for Cycles + AgX (emission 1-14, mirror chrome). Under ACES + bloom, glowing accents
 * become matte light sources at a luminance just over the bloom threshold, glass bodies take the element's colour
 * at the rim, chrome broadens its highlights, Titan shells become forged metal. Same intent as the FORGE hall.
 */
export function finishAvatarMaterial(m: THREE.MeshStandardMaterial, accent: THREE.Color): void {
  if (m.userData.finished) return;
  m.userData.finished = true;
  const s = m.emissiveIntensity, lit = m.emissive.r + m.emissive.g + m.emissive.b > 0;
  if (lit && m.metalness < 0.5 && !/gold/.test(m.name)) {
    const faint = /faint/.test(m.name);
    const target = (1.0 + 0.2 * Math.min(s, 3)) * (faint ? 1.3 : 1);
    m.emissiveIntensity = Math.min(10, target / Math.max(luma(m.emissive), 0.05));
    m.color.setRGB(0, 0, 0);
    m.roughness = 1;
    m.metalness = 0;
    m.envMapIntensity = 0;
    return;
  }
  if (/glass/.test(m.name) && m.transparent) {
    m.emissive.copy(accent);
    m.emissiveIntensity = Math.min(2.5, 0.45 / Math.max(luma(accent), 0.05));
    m.opacity = Math.min(m.opacity, 0.35);
    m.envMapIntensity = 0.6;
    m.depthWrite = false;
    return;
  }
  if (lit) m.emissiveIntensity = 1.05 * s / (1 + s);
  if (/titan_chrome/.test(m.name)) {
    const mx = Math.max(m.color.r, m.color.g, m.color.b);
    if (mx < 0.22) m.color.multiplyScalar(0.22 / Math.max(mx, 1e-3));
    m.metalness = 0.92;
    m.roughness = 0.38;
    m.envMapIntensity = 1.5;
  } else if (m.metalness > 0.5) {
    m.roughness = Math.max(m.roughness, 0.34);
    m.envMapIntensity = 0.9;
  } else {
    m.envMapIntensity = 0.7;
  }
}
