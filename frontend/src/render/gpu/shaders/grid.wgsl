@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let x = select(-1.0, 1.0, (index & 1u) == 1u);
  let y = select(-1.0, 1.0, (index & 2u) == 2u);
  return vec4f(x, y, 0.0, 1.0);
}
