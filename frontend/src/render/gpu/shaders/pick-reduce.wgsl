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
  distance: f32,
  time: f32,
  value: f32,
  valid: u32,
  reserved0: u32,
  reserved1: u32,
};

@group(0) @binding(0) var<uniform> request: Request;
@group(0) @binding(1) var<storage, read> candidates: array<Candidate>;
@group(0) @binding(2) var<storage, read_write> result: array<u32>;

@compute @workgroup_size(1)
fn main() {
  var best_distance = 3.402823e+38;
  var best_slot = 0xffffffffu;
  var best_time = 0.0;
  var best_value = 0.0;
  var valid = 0u;
  for (var index = 0u; index < request.candidate_count; index += 1u) {
    let candidate = candidates[index];
    if (candidate.valid == 0u || candidate.sequence != request.sequence) { continue; }
    if (candidate.distance < best_distance ||
      (candidate.distance == best_distance && candidate.series_slot < best_slot)) {
      best_distance = candidate.distance;
      best_slot = candidate.series_slot;
      best_time = candidate.time;
      best_value = candidate.value;
      valid = 1u;
    }
  }
  result[0] = request.sequence;
  result[1] = best_slot;
  result[2] = bitcast<u32>(best_distance);
  result[3] = bitcast<u32>(best_time);
  result[4] = bitcast<u32>(best_value);
  result[5] = valid;
  result[6] = 0u;
  result[7] = 0u;
}
