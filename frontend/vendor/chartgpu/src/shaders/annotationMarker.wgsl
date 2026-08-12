// annotationMarker.wgsl
// Instanced annotation marker shader (circle SDF with optional stroke).
//
// Coordinate contract:
// - Instance center is CANVAS-LOCAL CSS pixels (xCssPx, yCssPx)
// - Instance size is diameter in CSS pixels (sizeCssPx)
// - Uniform provides render target size in *device* pixels and DPR for CSS→device conversion.
//
// Draw call: draw(6, instanceCount) using triangle-list quad expansion in VS.

struct VSUniforms {
  viewportPx: vec2<f32>, // render target size in device pixels (width, height)
  dpr: f32,              // device pixel ratio (CSS px -> device px)
  _pad0: f32,
};

@group(0) @binding(0) var<uniform> vsUniforms: VSUniforms;

struct VSIn {
  // Center in CANVAS-LOCAL CSS pixels.
  @location(0) centerCssPx: vec2<f32>,
  // Marker diameter in CSS pixels.
  @location(1) sizeCssPx: f32,
  // Stroke width in CSS pixels (0 disables stroke).
  @location(2) strokeWidthCssPx: f32,
  // Colors are straight-alpha RGBA in 0..1.
  @location(3) fillRgba: vec4<f32>,
  @location(4) strokeRgba: vec4<f32>,
};

struct VSOut {
  @builtin(position) clipPosition: vec4<f32>,
  // Local quad coordinates in [-1, 1]^2 (used for circle SDF).
  @location(0) local: vec2<f32>,
  // Half-size in device pixels (radius in screen space).
  @location(1) halfSizePx: f32,
  @location(2) strokeWidthPx: f32,
  @location(3) fillRgba: vec4<f32>,
  @location(4) strokeRgba: vec4<f32>,
};

@vertex
fn vsMain(in: VSIn, @builtin(vertex_index) vertexIndex: u32) -> VSOut {
  // Fixed local corners for 2 triangles (triangle-list).
  let localCorners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0)
  );

  let corner = localCorners[vertexIndex];

  let dpr = select(1.0, vsUniforms.dpr, vsUniforms.dpr > 0.0);
  let centerPx = in.centerCssPx * dpr;
  let halfSizePx = 0.5 * max(0.0, in.sizeCssPx) * dpr;
  let strokeWidthPx = max(0.0, in.strokeWidthCssPx) * dpr;

  let posPx = centerPx + corner * halfSizePx;

  // Convert device pixels to clip-space with origin at top-left:
  // x: [0..w] -> [-1..1], y: [0..h] -> [1..-1]
  let clipX = (posPx.x / vsUniforms.viewportPx.x) * 2.0 - 1.0;
  let clipY = 1.0 - (posPx.y / vsUniforms.viewportPx.y) * 2.0;

  var out: VSOut;
  out.clipPosition = vec4<f32>(clipX, clipY, 0.0, 1.0);
  out.local = corner;
  out.halfSizePx = halfSizePx;
  out.strokeWidthPx = strokeWidthPx;
  out.fillRgba = in.fillRgba;
  out.strokeRgba = in.strokeRgba;
  return out;
}

@fragment
fn fsMain(in: VSOut) -> @location(0) vec4<f32> {
  if (in.halfSizePx <= 0.0) {
    discard;
  }

  // Circle SDF in normalized space: dist == 1 at the circle boundary.
  let dist = length(in.local);
  let aa = max(1e-6, fwidth(dist));

  // Coverage inside the circle.
  let outerCoverage = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, dist);
  if (outerCoverage <= 0.0) {
    discard;
  }

  // Optional stroke: compute inner radius in normalized units.
  let strokeNorm = clamp(in.strokeWidthPx / max(1e-6, in.halfSizePx), 0.0, 1.0);
  let inner = max(0.0, 1.0 - strokeNorm);
  let innerCoverage = 1.0 - smoothstep(inner - aa, inner + aa, dist);

  let fillCoverage = clamp(innerCoverage, 0.0, 1.0);
  let strokeCoverage = clamp(outerCoverage - innerCoverage, 0.0, 1.0);

  let fillA = clamp(in.fillRgba.a, 0.0, 1.0) * fillCoverage;
  let strokeA = clamp(in.strokeRgba.a, 0.0, 1.0) * strokeCoverage;
  let outA = fillA + strokeA;
  if (outA <= 0.0) {
    discard;
  }

  // Straight-alpha output: compute a weighted average RGB for correct blending.
  let rgb = (in.fillRgba.rgb * fillA + in.strokeRgba.rgb * strokeA) / outA;
  return vec4<f32>(rgb, outA);
}

