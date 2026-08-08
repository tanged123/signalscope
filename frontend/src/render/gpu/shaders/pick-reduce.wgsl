struct Request {
  cursor_x: f32,
  cursor_y: f32,
  radius: f32,
  sequence: u32,
  view_origin_high: f32,
  view_origin_low: f32,
  time_scale: f32,
  plot_x: f32,
  plot_y: f32,
  plot_width: f32,
  plot_height: f32,
  canvas_height: f32,
  y_min: f32,
  y_scale: f32,
  canvas_width: f32,
  candidate_count: u32,
  reserved0: vec4<u32>,
};
struct Candidate {
  sequence: u32,
  series_slot: u32,
  tile_meta_index: u32,
  distance: f32,
  relative_time: f32,
  value: f32,
  valid: u32,
  reserved: u32,
};

@group(0) @binding(0) var<uniform> request: Request;
@group(0) @binding(1) var<storage, read> candidates: array<Candidate>;
@group(0) @binding(2) var<storage, read_write> output: array<Candidate>;
@group(0) @binding(3) var<uniform> params: vec4<u32>;

var<workgroup> scratch: array<Candidate, 256>;

fn invalid() -> Candidate {
  return Candidate(request.sequence, 0xffffffffu, 0xffffffffu, 0.0, 0.0, 0.0, 0u, 0u);
}

fn nearer(left: Candidate, right: Candidate) -> Candidate {
  if (left.valid == 0u) {
    return right;
  }
  if (right.valid == 0u) {
    return left;
  }
  if (right.distance < left.distance ||
    (right.distance == left.distance && right.series_slot < left.series_slot)) {
    return right;
  }
  return left;
}

@compute @workgroup_size(256)
fn main(
  @builtin(local_invocation_id) local_id: vec3<u32>,
  @builtin(workgroup_id) workgroup_id: vec3<u32>,
) {
  let local = local_id.x;
  let index = workgroup_id.x * 256u + local;
  var candidate = invalid();
  if (index < params.x) {
    candidate = candidates[index];
  }
  scratch[local] = candidate;
  workgroupBarrier();
  var stride = 128u;
  while (stride > 0u) {
    if (local < stride) {
      scratch[local] = nearer(scratch[local], scratch[local + stride]);
    }
    workgroupBarrier();
    stride /= 2u;
  }
  if (local == 0u) {
    output[workgroup_id.x] = scratch[0];
  }
}
