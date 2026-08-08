struct View {
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
  dense: f32,
  canvas_width: f32,
};

struct Point { time_offset: f32, value: f32, flags: u32, reserved: u32 };
struct Descriptor { first_point: u32, second_point: u32, series_slot: u32, source_order: u32 };
struct Style { rgba: vec4f, width: f32, dash: u32, flags: u32, reserved: u32 };
struct TileMeta { point_start: u32, point_count: u32, origin_high: f32, origin_low: f32 };

@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<storage, read> points: array<Point>;
@group(0) @binding(2) var<storage, read> descriptors: array<Descriptor>;
@group(0) @binding(3) var<storage, read> styles: array<Style>;
@group(0) @binding(4) var<storage, read> tile_meta: array<TileMeta>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) edge: f32,
  @location(1) @interpolate(flat) dash: u32,
  @location(2) color: vec4f,
  @location(3) width: f32,
};

fn outside() -> vec4f { return vec4f(2.0, 2.0, 0.0, 1.0); }

fn origin_for(point_index: u32) -> vec2f {
  for (var index = 0u; index < arrayLength(&tile_meta); index += 1u) {
    let tile = tile_meta[index];
    if (point_index >= tile.point_start && point_index < tile.point_start + tile.point_count) {
      return vec2f(tile.origin_high, tile.origin_low);
    }
  }
  return vec2f(0.0, 0.0);
}

fn project(point_index: u32) -> vec2f {
  let point = points[point_index];
  let origin = origin_for(point_index);
  let time = (origin.x - view.view_origin_high) + (origin.y - view.view_origin_low) + point.time_offset;
  return vec2f(
    view.plot_x + time * view.time_scale,
    view.plot_y + view.plot_height - (point.value - view.y_min) * view.y_scale,
  );
}

fn clip(pixel: vec2f) -> vec4f {
  return vec4f(
    pixel.x / view.canvas_width * 2.0 - 1.0,
    1.0 - pixel.y / view.canvas_height * 2.0,
    0.0,
    1.0,
  );
}

fn eligible_for_hairline(style: Style) -> bool {
  return view.dense > 0.5 && style.dash == 0u && (style.flags & 2u) == 0u && style.width <= 1.4;
}

@vertex
fn vs_main(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOutput {
  let descriptor = descriptors[instance];
  let style = styles[descriptor.series_slot];
  var output: VertexOutput;
  output.edge = 0.0;
  output.dash = style.dash;
  output.color = style.rgba;
  output.width = style.width;
  if ((style.flags & 1u) == 0u || eligible_for_hairline(style)) {
    output.position = outside();
    return output;
  }
  let first = project(descriptor.first_point);
  let second = project(descriptor.second_point);
  let direction = normalize(second - first);
  let normal = vec2f(-direction.y, direction.x);
  let corners = array<vec2f, 6>(
    vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let corner = corners[vertex];
  let pixel = mix(first, second, corner.x) + normal * corner.y * (style.width * 0.5 + 1.0);
  output.edge = corner.y;
  output.position = clip(pixel);
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let edge = 1.0 - smoothstep(0.65, 1.0, abs(input.edge));
  let period = max(6.0, input.width * 6.0);
  let phase = fract(input.position.x / period);
  if ((input.dash == 1u && phase > 0.55) || (input.dash == 2u && phase > 0.2)) {
    discard;
  }
  let alpha = input.color.a * edge;
  return vec4f(input.color.rgb * alpha, alpha);
}
