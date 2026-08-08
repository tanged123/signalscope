struct Params {
  value_count: u32,
  reserved0: u32,
  reserved1: u32,
  reserved2: u32,
};

@group(0) @binding(0) var<storage, read_write> prefixes: array<u32>;
@group(0) @binding(1) var<storage, read> block_prefixes: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.value_count) {
    return;
  }
  prefixes[id.x] += block_prefixes[id.x / 256u];
}
