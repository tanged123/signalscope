@group(0) @binding(0) var<storage, read> totals: array<u32>;
@group(0) @binding(1) var<storage, read_write> descriptor_count: array<u32>;
@group(0) @binding(2) var<storage, read_write> quad_args: array<u32>;
@group(0) @binding(3) var<storage, read_write> hairline_args: array<u32>;

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x != 0u) {
    return;
  }
  let count = totals[0];
  descriptor_count[0] = count;
  quad_args[0] = 6u;
  quad_args[1] = count;
  quad_args[2] = 0u;
  quad_args[3] = 0u;
  hairline_args[0] = 2u;
  hairline_args[1] = count;
  hairline_args[2] = 0u;
  hairline_args[3] = 0u;
}
