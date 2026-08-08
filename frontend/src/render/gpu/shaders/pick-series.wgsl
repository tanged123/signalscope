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

struct Point { time_offset: f32, value: f32, flags: u32, reserved: u32 };
struct SeriesRange { point_start: u32, point_count: u32, series_slot: u32, tile_meta_index: u32 };
struct Style { rgba: vec4f, width: f32, dash: u32, flags: u32, reserved: u32 };
struct TileMeta { point_start: u32, point_count: u32, origin_high: f32, origin_low: f32 };
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
struct Page { candidate_offset: u32, series_count: u32, reserved0: u32, reserved1: u32 };

@group(0) @binding(0) var<uniform> request: Request;
@group(0) @binding(1) var<storage, read> points: array<Point>;
@group(0) @binding(2) var<storage, read> ranges: array<SeriesRange>;
@group(0) @binding(3) var<storage, read> tile_meta: array<TileMeta>;
@group(0) @binding(4) var<storage, read> styles: array<Style>;
@group(0) @binding(5) var<storage, read_write> candidates: array<Candidate>;
@group(0) @binding(6) var<uniform> page: Page;

fn point_time(point: Point, origin: vec2f) -> f32 {
  return origin.x + origin.y + point.time_offset;
}

fn project(point: Point, origin: vec2f) -> vec2f {
  let time = (origin.x - request.view_origin_high) +
    (origin.y - request.view_origin_low) + point.time_offset;
  return vec2f(
    request.plot_x + time * request.time_scale,
    request.plot_y + request.plot_height - (point.value - request.y_min) * request.y_scale,
  );
}

fn invalid() -> Candidate {
  return Candidate(request.sequence, 0xffffffffu, 0.0, 0.0, 0.0, 0u, 0u, 0u);
}

fn segment_candidate(
  first_index: u32,
  second_index: u32,
  series_slot: u32,
  origin: vec2f,
) -> Candidate {
  let first = points[first_index];
  let second = points[second_index];
  if ((second.flags & 1u) != 0u || first.value != first.value || second.value != second.value) {
    return invalid();
  }
  let first_pixel = project(first, origin);
  let second_pixel = project(second, origin);
  let direction = second_pixel - first_pixel;
  let length_squared = dot(direction, direction);
  let ratio = select(
    0.0,
    clamp(dot(vec2f(request.cursor_x, request.cursor_y) - first_pixel, direction) / length_squared, 0.0, 1.0),
    length_squared > 0.0,
  );
  let pixel = first_pixel + direction * ratio;
  let distance_px = distance(pixel, vec2f(request.cursor_x, request.cursor_y));
  if (distance_px > request.radius) {
    return invalid();
  }
  return Candidate(
    request.sequence,
    series_slot,
    distance_px,
    mix(point_time(first, origin), point_time(second, origin), ratio),
    mix(first.value, second.value, ratio),
    1u,
    0u,
    0u,
  );
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
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= page.series_count) {
    return;
  }
  let range = ranges[id.x];
  let style = styles[range.series_slot];
  let output_index = page.candidate_offset + id.x;
  if ((style.flags & 1u) == 0u || range.point_count == 0u) {
    candidates[output_index] = invalid();
    return;
  }
  let tile = tile_meta[range.tile_meta_index];
  let origin = vec2f(tile.origin_high, tile.origin_low);
  let cursor_time = request.view_origin_high + request.view_origin_low +
    (request.cursor_x - request.plot_x) / request.time_scale;
  var low = 0u;
  var high = range.point_count;
  while (low < high) {
    let middle = (low + high) / 2u;
    if (point_time(points[range.point_start + middle], origin) < cursor_time) {
      low = middle + 1u;
    } else {
      high = middle;
    }
  }
  var best = invalid();
  if (range.point_count == 1u) {
    best = segment_candidate(range.point_start, range.point_start, range.series_slot, origin);
  } else if (low == 0u) {
    best = segment_candidate(range.point_start, range.point_start + 1u, range.series_slot, origin);
  } else if (low >= range.point_count) {
    best = segment_candidate(
      range.point_start + range.point_count - 2u,
      range.point_start + range.point_count - 1u,
      range.series_slot,
      origin,
    );
  } else {
    best = segment_candidate(
      range.point_start + low - 1u,
      range.point_start + low,
      range.series_slot,
      origin,
    );
    if (low + 1u < range.point_count) {
      best = nearer(
        best,
        segment_candidate(
          range.point_start + low,
          range.point_start + low + 1u,
          range.series_slot,
          origin,
        ),
      );
    }
  }
  candidates[output_index] = best;
}
