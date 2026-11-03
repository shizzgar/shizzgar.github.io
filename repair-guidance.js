// Bounded, deterministic checks for observed runtime diagnostics. These are
// suggestions for the model to verify, never source rewrites or root-cause
// assertions. Unknown failures retain only their actual error and source.
export const PINNED_THREE_MODULE = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js';
export const MAX_REPAIR_GUIDANCE_CHARS = 2000;
export const MAX_REPAIR_GUIDANCE_CHECKS = 4;

function diagnosticText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(diagnosticText).filter(Boolean).join('\n');
  return value && typeof value.message === 'string' ? value.message : '';
}

const legacyGeometryAliases = new Map([
  'Box', 'Plane', 'Sphere', 'Cylinder', 'Cone', 'Circle', 'Ring', 'Torus',
  'TorusKnot', 'Tube', 'Lathe', 'Extrude', 'Shape', 'Icosahedron',
  'Dodecahedron', 'Octahedron', 'Tetrahedron', 'Polyhedron',
].map(name => [`${name}BufferGeometry`, `${name}Geometry`]));

function coreExportCheck(text) {
  const direct = /\bTHREE\.([A-Za-z_$][\w$]*)\s+is\s+(?:not\s+(?:a\s+)?(?:constructor|function)|undefined)/i.exec(text);
  const named = /does not provide an export named\s+['"]([A-Za-z_$][\w$]*)['"]/i.exec(text);
  const symbol = direct?.[1] || named?.[1];
  if (!symbol && !(text.includes('THREE.Math.') && /TypeError|undefined/i.test(text))) return '';
  if (legacyGeometryAliases.has(symbol)) {
    return `Check the r160 core API: ${symbol} is an obsolete alias; ${legacyGeometryAliases.get(symbol)} is the exported geometry class in the pinned version. Verify the constructor arguments and preserve the intended geometry; do not just rename an unknown symbol.`;
  }
  if (symbol === 'Geometry' || symbol === 'Face3') {
    return `Check the r160 core API: ${symbol} is not exported. Represent the same mesh with BufferGeometry position attributes and indices; this is an API migration, not a drop-in constructor substitution. Preserve the intended geometry.`;
  }
  if (symbol === 'Math' || text.includes('THREE.Math.')) {
    return 'Check the pinned r160 API: math helpers are exposed by THREE.MathUtils. Verify the specific helper exists and its arguments match; do not infer a replacement for an unrelated undefined value.';
  }
  if (['OrbitControls','RoundedBoxGeometry','TextGeometry','FontLoader'].includes(symbol)) {
    return `Check the core-only dependency constraint: ${symbol} is not an export of the pinned Three.js core module. Preserve its intended behavior using supported core geometry or inline controls; do not add an unavailable addon dependency.`;
  }
  return 'Check the exact missing constructor or named export against the pinned Three.js r160 core API and the import namespace. The diagnostic alone does not identify a valid replacement: verify the symbol before changing it, and preserve the requested behavior.';
}

/** Return at most four checks, bounded independently of the original log. */
export function buildRepairGuidance(diagnostics) {
  const value = diagnosticText(diagnostics);
  // Callers already bound repair errors, but keep direct use predictable too.
  const text = value.length <= 64000 ? value : value.slice(0,32000) + '\n' + value.slice(-32000);
  const checks = [];
  const add = (id, message) => { checks.push({id, text:message}); };

  if (/\bvFogDepth\b/i.test(text) && /varying|does not match|undeclared|not declared/i.test(text)) {
    add('fog-varying', 'Check the custom fog shader interface. In ShaderMaterial, include matching fog_pars_vertex/fog_vertex and fog_pars_fragment/fog_fragment chunks in the proper stages; fog_vertex needs the computed mvPosition. Verify vFogDepth is declared and written by the vertex shader before the fragment shader reads it. Preserve the fog effect.');
  }
  if (/\brefreshFogUniforms\b/.test(text)) {
    add('uniform-layout', 'Check custom ShaderMaterial uniforms when material.fog is true. Merge THREE.UniformsLib.fog with the existing custom uniforms using THREE.UniformsUtils.merge, and retain the expected fogColor plus fogNear/fogFar or fogDensity values for the scene fog type. Do not discard the custom uniforms or remove fog merely to hide the error.');
  } else if (/uniforms\b|uniforms\./.test(text) && /(?:TypeError|undefined|Cannot (?:read|set))/.test(text) && /\bvalue\b/.test(text)) {
    add('uniform-layout', 'Check the specific custom uniform named by the exception and focused source line. ShaderMaterial uniforms use objects of the form {value: ...}; verify that the key exists before updating its value, preserve other uniforms, and keep its JavaScript value compatible with the GLSL declaration.');
  }
  if (/Политика выполнения сцены заблокировала скрипт|scene execution policy blocked a script|Refused to (?:load|execute|evaluate)[\s\S]{0,250}(?:script|Content Security Policy)|violates[\s\S]{0,150}(?:script-src|Content Security Policy)|Failed to resolve module specifier[\s\S]{0,150}(?:three|addons|OrbitControls)/i.test(text)) {
    add('script-policy', `Check the sandbox dependency policy: use only inline implementation code and the exact pinned core module ${PINNED_THREE_MODULE}. Keep camera controls and needed behavior in the document; do not import addons, use eval/new Function, weaken CSP, or ask the user to change browser security settings.`);
  }
  if (/WebGL-контекст есть, но вызовы отрисовки не обнаружены|WebGL[\s\S]{0,120}(?:первый кадр не нарисован|draw-вызовов не обнаружено)|no (?:WebGL )?draw calls|first (?:rendered )?frame[\s\S]{0,60}(?:absent|missing|not rendered)/i.test(text)) {
    add('first-frame', 'Check the first frame separately from the animation loop: attach the renderer canvas with nonzero dimensions, position the camera to see the intended objects, and call renderer.render(scene, camera) once after building the scene and updating the camera. Then start requestAnimationFrame or setAnimationLoop without omitting the render call. Preserve scene content.');
  }
  const coreCheck = coreExportCheck(text);
  if (coreCheck) add('core-export', coreCheck);
  if (/THREE\.WebGLProgram:[\s\S]{0,100}(?:Shader Error|VALIDATE_STATUS)|(?:VERTEX|FRAGMENT)\s+SHADER[\s\S]{0,150}(?:ERROR|compile)|shader (?:compile|compilation|link|linking) (?:error|failed)|Program Info Log:[\s\S]{0,120}\S/i.test(text)) {
    add('shader-program', 'Use the actual shader compiler/linker log and its reported stage and line to inspect the custom shader. Check vertex/fragment interfaces, declared identifiers and GLSL types, and the prefix/chunks supplied by ShaderMaterial versus RawShaderMaterial. Fix the offending shader; do not suppress diagnostics or replace the scene with a placeholder.');
  }
  if (/Canvas сцены не имеет видимого размера|В сцене не появился canvas для 3D-рендеринга|scene canvas has no visible size|scene did not create a canvas/i.test(text)) {
    add('canvas-viewport', 'Check that renderer.domElement is attached to the document, its container and canvas have nonzero visible dimensions, and renderer.setSize plus camera.aspect use the iframe viewport. Update the projection matrix after aspect changes and render a first frame after setup.');
  }
  if (/\bWebGL\b[\s\S]{0,220}\b(?:INVALID_ENUM|INVALID_VALUE|INVALID_OPERATION|INVALID_FRAMEBUFFER_OPERATION|OUT_OF_MEMORY)\b/i.test(text)) {
    add('webgl-state', /\bOUT_OF_MEMORY\b/.test(text)
      ? 'Check the sampled WebGL OUT_OF_MEMORY as a failed graphics allocation, not a measurement of free VRAM. Inspect texture/render-target dimensions against actual device limits and resource lifetime; dispose superseded textures, geometries, materials and render targets before replacing them. Preserve the scene design and validate again.'
      : 'Check the sampled WebGL error against the current program, framebuffer, attributes, indices and texture state. Use any compiler/linker diagnostics to fix the invalid state before rendering again. Do not merely catch or hide the error, and do not infer a memory shortage from INVALID_OPERATION.');
  }

  let used = 0;
  return checks.filter(check => {
    if (used + check.text.length > MAX_REPAIR_GUIDANCE_CHARS) return false;
    used += check.text.length;
    return true;
  }).slice(0, MAX_REPAIR_GUIDANCE_CHECKS);
}
