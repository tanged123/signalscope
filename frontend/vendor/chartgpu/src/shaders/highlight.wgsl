// highlight.wgsl
// Draws an anti-aliased ring highlight around a point.
//
// Contract:
// - `@builtin(position)` in the fragment stage is framebuffer-space pixels.
// - The renderer supplies `center` and ring sizes in *device pixels*.

struct Uniforms {
  center: vec2<f32>,
  radius: f32,
  thickness: f32,
  color: vec4<f32>,
  outlineColor: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSOut {
  @builtin(position) position: vec4<f32>,
};

@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> VSOut {
  // Fullscreen triangle.
  // Covers clip-space [-1,1] with 3 verts: (-1,-1), (3,-1), (-1,3)
  let positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0)
  );

  var out: VSOut;
  out.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  return out;
}

fn ringCoverage(distancePx: f32, radiusPx: f32, thicknessPx: f32) -> f32 {
  let aa = 1.0; // ~1px antialias band (device pixels)
  let halfT = max(0.5, thicknessPx * 0.5);
  let a0 = smoothstep(radiusPx - halfT - aa, radiusPx - halfT + aa, distancePx);
  let a1 = smoothstep(radiusPx + halfT - aa, radiusPx + halfT + aa, distancePx);
  return clamp(a0 - a1, 0.0, 1.0);
}

@fragment
fn fsMain(@builtin(position) fragPos: vec4<f32>) -> @location(0) vec4<f32> {
  let d = distance(fragPos.xy, u.center);

  let ring = ringCoverage(d, u.radius, u.thickness);
  let outline = ringCoverage(d, u.radius, u.thickness + 2.0);

  let cover = max(ring, outline);
  if (cover <= 0.0) {
    discard;
  }

  // Blend between outline and ring color based on relative coverage,
  // then apply total coverage as alpha.
  let t = clamp(select(0.0, ring / cover, cover > 0.0), 0.0, 1.0);
  let rgb = mix(u.outlineColor.rgb, u.color.rgb, t);
  let a = mix(u.outlineColor.a, u.color.a, t) * cover;
  return vec4<f32>(rgb, a);
}

