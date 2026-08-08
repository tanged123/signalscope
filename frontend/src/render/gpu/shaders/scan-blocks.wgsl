struct Params {
  value_count: u32,
  reserved0: u32,
  reserved1: u32,
  reserved2: u32,
};

@group(0) @binding(0) var<storage, read> input_values: array<u32>;
@group(0) @binding(1) var<storage, read_write> output_values: array<u32>;
@group(0) @binding(2) var<storage, read_write> block_sums: array<u32>;
@group(0) @binding(3) var<uniform> params: Params;

var<workgroup> scan: array<u32, 256>;

@compute @workgroup_size(256)
fn main(
  @builtin(global_invocation_id) global_id: vec3<u32>,
  @builtin(local_invocation_id) local_id: vec3<u32>,
  @builtin(workgroup_id) workgroup_id: vec3<u32>,
) {
  let local = local_id.x;
  let index = global_id.x;
  var value = 0u;
  if (index < params.value_count) {
    value = input_values[index];
  }
  scan[local] = value;
  workgroupBarrier();

  var stride = 1u;
  while (stride < 256u) {
    let offset = (local + 1u) * stride * 2u - 1u;
    if (offset < 256u) {
      scan[offset] += scan[offset - stride];
    }
    workgroupBarrier();
    stride *= 2u;
  }

  if (local == 255u) {
    block_sums[workgroup_id.x] = scan[255];
    scan[255] = 0u;
  }
  workgroupBarrier();

  stride = 128u;
  loop {
    let offset = (local + 1u) * stride * 2u - 1u;
    if (offset < 256u) {
      let left = offset - stride;
      let value = scan[left];
      scan[left] = scan[offset];
      scan[offset] += value;
    }
    workgroupBarrier();
    if (stride == 1u) {
      break;
    }
    stride /= 2u;
  }
  if (index < params.value_count) {
    output_values[index] = scan[local];
  }
}
